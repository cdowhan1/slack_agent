const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Initialize Claude
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ========================================
// GUARDRAILS CONFIGURATION
// ========================================

// 1. ALLOWED USERS (Whitelist specific Slack user IDs)
const ALLOWED_USERS = [
  // Add Slack user IDs here, or leave empty to allow all
  'U082519ACD8', //Ryan V 
  'U096RH2T72S', //Carson D
  'U0821FVJ24D', //George N
  'U093Q23Q9C0', //John T
  'U082635FQP9' //Sammy V
  // 'U56789EFGH',
];

// 2. ADMIN USERS (Can perform write operations)
const ADMIN_USERS = [
  'U082519ACD8', //Ryan V 
  'U096RH2T72S', //Carson D
  'U0821FVJ24D', //George N
  'U093Q23Q9C0', //John T
  'U082635FQP9' //Sammy V
];

// 3. ALLOWED OPERATIONS
const ALLOWED_OPERATIONS = {
  read: true,      // Allow read queries (products, inventory lookup)
  update: false,   // Allow updates (inventory changes, price updates)
  create: false,   // Allow creating new products
  delete: false,   // Allow deleting products
};

// 4. RATE LIMITING (per user)
const RATE_LIMIT = {
  maxRequests: 10,     // Max requests per time window
  windowMs: 60000,     // Time window in milliseconds (60000 = 1 minute)
};

// Store rate limit data
const userRequestCounts = new Map();

// 5. SENSITIVE OPERATIONS (require confirmation)
const SENSITIVE_KEYWORDS = [
  'delete',
  'remove',
  'update price',
  'change price',
  'bulk update',
];

// ========================================
// HELPER FUNCTIONS
// ========================================

// Check if user is allowed
function isUserAllowed(userId) {
  if (ALLOWED_USERS.length === 0) return true; // Empty list = allow all
  return ALLOWED_USERS.includes(userId);
}

// Check if user is admin
function isUserAdmin(userId) {
  return ADMIN_USERS.includes(userId);
}

// Rate limiting check
function checkRateLimit(userId) {
  const now = Date.now();
  const userRequests = userRequestCounts.get(userId) || [];
  
  // Remove old requests outside the time window
  const recentRequests = userRequests.filter(
    timestamp => now - timestamp < RATE_LIMIT.windowMs
  );
  
  if (recentRequests.length >= RATE_LIMIT.maxRequests) {
    return false; // Rate limit exceeded
  }
  
  // Add current request
  recentRequests.push(now);
  userRequestCounts.set(userId, recentRequests);
  
  return true;
}

// Check if query is a write operation
function isWriteOperation(message) {
  const writeKeywords = [
    'update',
    'change',
    'modify',
    'set',
    'delete',
    'remove',
    'create',
    'add new',
  ];
  
  const lowerMessage = message.toLowerCase();
  return writeKeywords.some(keyword => lowerMessage.includes(keyword));
}

// Check if query contains sensitive operations
function containsSensitiveOperation(message) {
  const lowerMessage = message.toLowerCase();
  return SENSITIVE_KEYWORDS.some(keyword => lowerMessage.includes(keyword));
}

// Detect mutation queries (GraphQL writes)
function isMutationQuery(graphqlQuery) {
  const queryLower = graphqlQuery.toLowerCase();
  return queryLower.includes('mutation') || 
         queryLower.includes('update') ||
         queryLower.includes('delete') ||
         queryLower.includes('create');
}

// Function to query Shopify
async function queryShopify(graphqlQuery) {
  const response = await fetch(
    `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2025-10/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: graphqlQuery }),
    }
  );
  return await response.json();
}

// ========================================
// MESSAGE HANDLERS
// ========================================

// Handle app mentions and DMs
app.event('app_mention', async ({ event, say }) => {
  await handleMessage(event.text, event.user, say);
});

app.message(async ({ message, say }) => {
  // Only respond to DMs (not channel messages without @mention)
  if (message.channel_type === 'im') {
    await handleMessage(message.text, message.user, say);
  }
});

async function handleMessage(userMessage, userId, say, client, channelId) {
  try {
    // Remove bot mention from message
    const cleanMessage = userMessage.replace(/<@[A-Z0-9]+>/g, '').trim();
    
    // Show typing indicator
    if (client && channelId) {
      await client.conversations.typing({ channel: channelId });
    }
    
    // ========================================
    // GUARDRAIL 1: Check if user is allowed
    // ========================================
    if (!isUserAllowed(userId)) {
      await say('❌ Sorry, you are not authorized to use this bot. Please contact an administrator.');
      return;
    }
    
    // ========================================
    // GUARDRAIL 2: Rate limiting
    // ========================================
    if (!checkRateLimit(userId)) {
      await say(`⏳ Rate limit exceeded. Please wait a minute before making more requests. (Limit: ${RATE_LIMIT.maxRequests} requests per minute)`);
      return;
    }
    
    // ========================================
    // GUARDRAIL 3: Check for write operations
    // ========================================
    if (isWriteOperation(cleanMessage)) {
      if (!ALLOWED_OPERATIONS.update && !isUserAdmin(userId)) {
        await say('❌ Write operations are disabled. You can only perform read-only queries.');
        return;
      }
      
      if (!isUserAdmin(userId)) {
        await say('❌ Only administrators can perform update operations.');
        return;
      }
    }
    
    // ========================================
    // GUARDRAIL 4: Sensitive operations warning
    // ========================================
    if (containsSensitiveOperation(cleanMessage)) {
      await say('⚠️ This appears to be a sensitive operation. Please confirm by typing "CONFIRM" or "CANCEL"');
      // Note: You'd need to implement confirmation logic here
      // For now, we'll just warn and continue
    }
    
    // Step 1: Ask Claude to generate GraphQL query
    const queryResponse = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      system: `You are a Shopify GraphQL expert. Convert natural language questions into valid Shopify GraphQL queries.

IMPORTANT RESTRICTIONS:
- ONLY generate READ queries (no mutations unless explicitly allowed)
- Use "query" keyword, NOT "mutation"
- Focus on: products, productVariants, inventory lookups
- Do NOT generate: productUpdate, productDelete, inventoryAdjust

Examples:
- "show products under $50" → query { products(first: 50, query: "variants.price:<50") { edges { node { id title variants(first: 1) { edges { node { price } } } } } } }
- "inventory for SKU-123" → query { productVariants(first: 10, query: "sku:SKU-123") { edges { node { sku inventoryQuantity product { title } } } } }
- "products from vendor Nike" → query { products(first: 50, query: "vendor:Nike") { edges { node { id title vendor } } } }

Only return the GraphQL query string, nothing else. No markdown, no explanations.`,
      messages: [
        {
          role: 'user',
          content: cleanMessage,
        },
      ],
    });

    const graphqlQuery = queryResponse.content[0].text.trim();
    
    // ========================================
    // GUARDRAIL 5: Block mutation queries
    // ========================================
    if (isMutationQuery(graphqlQuery)) {
      if (!ALLOWED_OPERATIONS.update || !isUserAdmin(userId)) {
        await say('❌ This query would modify data. Mutations are not allowed. Please use read-only queries.');
        return;
      }
    }
    
    // Log the query for audit purposes
    console.log(`[${new Date().toISOString()}] User ${userId} executed query:`, graphqlQuery);
    
    // Step 2: Execute query on Shopify
    const shopifyData = await queryShopify(graphqlQuery);
    
    // Check for errors
    if (shopifyData.errors) {
      await say(`❌ Shopify API error: ${JSON.stringify(shopifyData.errors)}`);
      return;
    }
    
    // Step 3: Ask Claude to format the response
    const formatResponse = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2048,
      system: `You are a helpful assistant formatting Shopify data for Slack. 
      
Make the response:
- Easy to read with bullet points
- Include relevant emojis
- Highlight important info (prices, inventory levels)
- Keep it concise but informative
- Use Slack formatting (use *bold* for emphasis)
- Maximum 10 items per response`,
      messages: [
        {
          role: 'user',
          content: `The user asked: "${cleanMessage}"\n\nHere's the Shopify data:\n${JSON.stringify(shopifyData.data, null, 2)}\n\nPlease format this in a friendly way for Slack.`,
        },
      ],
    });

    const formattedResponse = formatResponse.content[0].text;
    
    // Step 4: Send response back to Slack
    await say(formattedResponse);
    
  } catch (error) {
    console.error('Error:', error);
    await say(`❌ Sorry, I encountered an error: ${error.message}`);
  }
}

// Start the app
(async () => {
  await app.start();
  console.log('⚡️ Shopify AI Assistant is running!');
  console.log('Guardrails enabled:');
  console.log(`  - User whitelist: ${ALLOWED_USERS.length > 0 ? 'Yes' : 'No (all users allowed)'}`);
  console.log(`  - Admin users: ${ADMIN_USERS.length}`);
  console.log(`  - Write operations: ${ALLOWED_OPERATIONS.update ? 'Enabled' : 'Disabled'}`);
  console.log(`  - Rate limit: ${RATE_LIMIT.maxRequests} requests per ${RATE_LIMIT.windowMs/1000} seconds`);
})();

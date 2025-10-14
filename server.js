const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');

// Validate environment variables
console.log('🔍 Checking environment variables...');
console.log('SLACK_BOT_TOKEN:', process.env.SLACK_BOT_TOKEN ? '✅ Set' : '❌ Missing');
console.log('SLACK_APP_TOKEN:', process.env.SLACK_APP_TOKEN ? '✅ Set' : '❌ Missing');
console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? '✅ Set' : '❌ Missing');
console.log('SHOPIFY_STORE_URL:', process.env.SHOPIFY_STORE_URL ? '✅ Set' : '❌ Missing');
console.log('SHOPIFY_ACCESS_TOKEN:', process.env.SHOPIFY_ACCESS_TOKEN ? '✅ Set' : '❌ Missing');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌ FATAL: ANTHROPIC_API_KEY environment variable is not set!');
  process.exit(1);
}

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
});

// Initialize Claude with error handling
let anthropic;
try {
  console.log('🤖 Initializing Anthropic SDK...');
  console.log('API Key prefix:', process.env.ANTHROPIC_API_KEY.substring(0, 15));
  
  anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  
  console.log('✅ Anthropic SDK initialized');
} catch (error) {
  console.error('❌ Failed to initialize Anthropic SDK:', error.message);
  process.exit(1);
}

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
app.event('app_mention', async ({ event, say, client }) => {
  await handleMessage(event.text, event.user, say, client, event.channel);
});

app.message(async ({ message, say, client }) => {
  // Only respond to DMs (not channel messages without @mention)
  if (message.channel_type === 'im') {
    await handleMessage(message.text, message.user, say, client, message.channel);
  }
});

async function handleMessage(userMessage, userId, say, client, channelId) {
  let statusMessage = null;
  
  try {
    // Remove bot mention from message
    const cleanMessage = userMessage.replace(/<@[A-Z0-9]+>/g, '').trim();
    
    // Send initial status message
    statusMessage = await say('🔍 Analyzing your request...');
    
    // ========================================
    // GUARDRAIL 1: Check if user is allowed
    // ========================================
    if (!isUserAllowed(userId)) {
      if (statusMessage && client && channelId) {
        await client.chat.update({
          channel: channelId,
          ts: statusMessage.ts,
          text: '❌ Sorry, you are not authorized to use this bot. Please contact an administrator.',
        });
      } else {
        await say('❌ Sorry, you are not authorized to use this bot. Please contact an administrator.');
      }
      return;
    }
    
    // ========================================
    // GUARDRAIL 2: Rate limiting
    // ========================================
    if (!checkRateLimit(userId)) {
      if (statusMessage && client && channelId) {
        await client.chat.update({
          channel: channelId,
          ts: statusMessage.ts,
          text: `⏳ Rate limit exceeded. Please wait a minute before making more requests. (Limit: ${RATE_LIMIT.maxRequests} requests per minute)`,
        });
      } else {
        await say(`⏳ Rate limit exceeded. Please wait a minute before making more requests. (Limit: ${RATE_LIMIT.maxRequests} requests per minute)`);
      }
      return;
    }
    
    // ========================================
    // GUARDRAIL 3: Check for write operations
    // ========================================
    if (isWriteOperation(cleanMessage)) {
      if (!ALLOWED_OPERATIONS.update && !isUserAdmin(userId)) {
        if (statusMessage && client && channelId) {
          await client.chat.update({
            channel: channelId,
            ts: statusMessage.ts,
            text: '❌ Write operations are disabled. You can only perform read-only queries.',
          });
        } else {
          await say('❌ Write operations are disabled. You can only perform read-only queries.');
        }
        return;
      }
      
      if (!isUserAdmin(userId)) {
        if (statusMessage && client && channelId) {
          await client.chat.update({
            channel: channelId,
            ts: statusMessage.ts,
            text: '❌ Only administrators can perform update operations.',
          });
        } else {
          await say('❌ Only administrators can perform update operations.');
        }
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
    
    // Update status: Generating query
    if (statusMessage && client && channelId) {
      await client.chat.update({
        channel: channelId,
        ts: statusMessage.ts,
        text: '🤖 Generating Shopify query...',
      });
    }
    
    // Step 1: Ask Claude to generate GraphQL query
    // Show typing again since this takes time
    if (client && channelId) {
      await client.conversations.typing({ channel: channelId });
    }
    
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
    
    // Update status: Querying Shopify
    if (statusMessage && client && channelId) {
      await client.chat.update({
        channel: channelId,
        ts: statusMessage.ts,
        text: '📦 Fetching data from Shopify...',
      });
    }
    
    // Show typing while executing Shopify query
    if (client && channelId) {
      await client.conversations.typing({ channel: channelId });
    }
    
    // ========================================
    // GUARDRAIL 5: Block mutation queries
    // ========================================
    if (isMutationQuery(graphqlQuery)) {
      if (!ALLOWED_OPERATIONS.update || !isUserAdmin(userId)) {
        if (statusMessage && client && channelId) {
          await client.chat.update({
            channel: channelId,
            ts: statusMessage.ts,
            text: '❌ This query would modify data. Mutations are not allowed. Please use read-only queries.',
          });
        } else {
          await say('❌ This query would modify data. Mutations are not allowed. Please use read-only queries.');
        }
        return;
      }
    }
    
    // Log the query for audit purposes
    console.log(`[${new Date().toISOString()}] User ${userId} executed query:`, graphqlQuery);
    
    // Step 2: Execute query on Shopify
    const shopifyData = await queryShopify(graphqlQuery);
    
    // Update status: Formatting response
    if (statusMessage && client && channelId) {
      await client.chat.update({
        channel: channelId,
        ts: statusMessage.ts,
        text: '✨ Formatting your results...',
      });
    }
    
    // Show typing while formatting response
    if (client && channelId) {
      await client.conversations.typing({ channel: channelId });
    }
    
    // Check for errors
    if (shopifyData.errors) {
      if (statusMessage && client && channelId) {
        await client.chat.update({
          channel: channelId,
          ts: statusMessage.ts,
          text: `❌ Shopify API error: ${JSON.stringify(shopifyData.errors)}`,
        });
      } else {
        await say(`❌ Shopify API error: ${JSON.stringify(shopifyData.errors)}`);
      }
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
    
    // Delete the status message (or update to "Done!")
    if (statusMessage && client && channelId) {
      await client.chat.delete({
        channel: channelId,
        ts: statusMessage.ts,
      });
    }
    
    // Step 4: Send response back to Slack
    await say(formattedResponse);
    
  } catch (error) {
    console.error('Error:', error);
    
    // Update status message with error
    if (statusMessage && client && channelId) {
      await client.chat.update({
        channel: channelId,
        ts: statusMessage.ts,
        text: `❌ Sorry, I encountered an error: ${error.message}`,
      });
    } else {
      await say(`❌ Sorry, I encountered an error: ${error.message}`);
    }
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

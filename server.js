const { App } = require('@slack/bolt');
const Anthropic = require('@anthropic-ai/sdk').default;
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

const ALLOWED_OPERATIONS = {
  read: true,
  update: true,   // Admins can update
  create: false,
  delete: false,
};

const RATE_LIMIT = {
  maxRequests: 10,
  windowMs: 60000, // 1 minute
};

const userRequestCounts = new Map();

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

function isUserAllowed(userId) {
  if (ALLOWED_USERS.length === 0) return true;
  return ALLOWED_USERS.includes(userId);
}

function isUserAdmin(userId) {
  return ADMIN_USERS.includes(userId);
}

function checkRateLimit(userId) {
  const now = Date.now();
  const userRequests = userRequestCounts.get(userId) || [];
  
  const recentRequests = userRequests.filter(
    timestamp => now - timestamp < RATE_LIMIT.windowMs
  );
  
  if (recentRequests.length >= RATE_LIMIT.maxRequests) {
    return false;
  }
  
  recentRequests.push(now);
  userRequestCounts.set(userId, recentRequests);
  
  return true;
}

function isWriteOperation(message) {
  const writeKeywords = [
    'update inventory',
    'change price',
    'modify product',
    'set price',
    'delete product',
    'remove product',
    'create product',
    'add product',
  ];
  
  const lowerMessage = message.toLowerCase();
  // Questions are always read operations
  if (lowerMessage.includes('what') || lowerMessage.includes('show') || 
      lowerMessage.includes('tell') || lowerMessage.includes('how')) {
    return false;
  }
  
  return writeKeywords.some(keyword => lowerMessage.includes(keyword));
}

function containsSensitiveOperation(message) {
  const lowerMessage = message.toLowerCase();
  return SENSITIVE_KEYWORDS.some(keyword => lowerMessage.includes(keyword));
}

function isMutationQuery(graphqlQuery) {
  const queryLower = graphqlQuery.toLowerCase();
  return queryLower.includes('mutation') || 
         queryLower.includes('update') ||
         queryLower.includes('delete') ||
         queryLower.includes('create');
}

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

app.event('app_mention', async ({ event, say, client }) => {
  await handleMessage(event.text, event.user, say, client, event.channel);
});

app.message(async ({ message, say, client }) => {
  if (message.channel_type === 'im' && message.text) {
    await handleMessage(message.text, message.user, say, client, message.channel);
  }
});

async function handleMessage(userMessage, userId, say, client, channelId) {
  let statusMessage = null;
  
  try {
    if (!userMessage || typeof userMessage !== 'string') {
      console.error('Invalid message received:', userMessage);
      return;
    }
    
    const cleanMessage = userMessage.replace(/<@[A-Z0-9]+>/g, '').trim();
    
    statusMessage = await say('🔍 Analyzing your request...');
    
    // ========================================
    // GUARDRAIL 1: Check if user is allowed
    // ========================================
    if (!isUserAllowed(userId)) {
      if (statusMessage && client && channelId && statusMessage.ts) {
        await client.chat.update({
          channel: channelId,
          ts: statusMessage.ts,
          text: '❌ Sorry, you are not authorized to use this bot.',
        });
      } else {
        await say('❌ Sorry, you are not authorized to use this bot.');
      }
      return;
    }
    
    // ========================================
    // GUARDRAIL 2: Rate limiting
    // ========================================
    if (!checkRateLimit(userId)) {
      if (statusMessage && client && channelId && statusMessage.ts) {
        await client.chat.update({
          channel: channelId,
          ts: statusMessage.ts,
          text: `⏳ Rate limit exceeded. Wait a minute. (Limit: ${RATE_LIMIT.maxRequests}/min)`,
        });
      } else {
        await say(`⏳ Rate limit exceeded. Wait a minute.`);
      }
      return;
    }
    
    // ========================================
    // GUARDRAIL 3: Check for write operations
    // ========================================
    if (isWriteOperation(cleanMessage)) {
      if (!ALLOWED_OPERATIONS.update && !isUserAdmin(userId)) {
        if (statusMessage && client && channelId && statusMessage.ts) {
          await client.chat.update({
            channel: channelId,
            ts: statusMessage.ts,
            text: '❌ Write operations are disabled. Read-only queries only.',
          });
        } else {
          await say('❌ Write operations are disabled.');
        }
        return;
      }
      
      if (!isUserAdmin(userId)) {
        if (statusMessage && client && channelId && statusMessage.ts) {
          await client.chat.update({
            channel: channelId,
            ts: statusMessage.ts,
            text: '❌ Only administrators can perform updates.',
          });
        } else {
          await say('❌ Only administrators can perform updates.');
        }
        return;
      }
    }
    
    // ========================================
    // GUARDRAIL 4: Sensitive operations warning
    // ========================================
    if (containsSensitiveOperation(cleanMessage)) {
      await say('⚠️ This is a sensitive operation. Type "CONFIRM" or "CANCEL"');
    }
    
    // Update status
    if (statusMessage && client && channelId && statusMessage.ts) {
      try {
        await client.chat.update({
          channel: channelId,
          ts: statusMessage.ts,
          text: '🤖 Generating Shopify query...',
        });
      } catch (updateError) {
        console.error('Failed to update status:', updateError.message);
      }
    }
    
    console.log('🤖 Calling Anthropic API...');
    
    // ========================================
    // STEP 1: Generate GraphQL Query with Claude
    // ========================================
    const queryResponse = await anthropic.messages.create({
      model: 'claude-3-5-haiku-latest',
      max_tokens: 1500,
      system: `You are a Shopify GraphQL expert for a trading card and collectibles store. Convert natural language questions into efficient GraphQL queries.

STORE STRUCTURE:
- product_type values: 
- "Sealed" (boxes/packs), 
- "Graded" or "Raw" (individual cards,Graded cards utilize the Grading and Grade metafields, since they've been graded and authenticated by a professional grader)
- "Jerseys" (for apparel), 
- "Sealed Case" (Cases, separate from "Sealed" due to higher pricep point and target consumer


AVAILABLE METAFIELDS: (If you cannot find a specific metafield, try messing with the cases and capitalizations (e.g Singlesent vs. singlesent)
- global.created_at: when product was created
- global.updated_at: when manually updated
- global.updated_price_count: count of manual discounts
- global.releasedate: release date
- global.serial: serial number
- global.supbrand,supplier brand 
- global.suptype: supplier type (not typically used)
- global.waxtype: variant for Sealed (e.g., "hobby box", "blaster box")
- global.waxman: manufacturer for Sealed products
- global.waxyear: production year (e.g., 2022)
- global.waxsport: sport for Sealed products (Baseball, Basketball, etc.)
- global.waxgame: game for Sealed
- global.waxent: entertainment for Sealed
- global.casetype: case type
- global.singlesgame: game for Singles (e.g., "Pokemon", "Magic")
- global.singlesent: entertainment for Singles
- global.sport: sport name (e.g., "Baseball", "Basketball")
- global.Modern: "Modern" or "Vintage"
- global.Grading: grading company (e.g., "PSA", "BGS", "CGC")
- global.Grade: grade number (e.g., "10", "9.5", "9")
- custom.player_name: player name ("Shohei Ohtani)
- custom.team: team name

QUERY STRATEGY FOR LARGE CATALOGS:
1. ALWAYS filter by product_type FIRST when relevant:
   - User mentions "sealed", "graded" or "raw" → query: "product_type:Sealed"
   - User mentions "cards", "singles", "graded" → query: "product_type:Singles"

2. Combine filters in query string for server-side filtering:
   query: "product_type:Singles AND title:*pikachu*"
   query: "product_type:Sealed AND title:*baseball*"

3. Fetch ONLY needed metafields using specific syntax:
   metafield(namespace: "custom", key: "Grade") { value } 
   Use aliases for readability: grade: metafield(namespace: "custom", key: "Grade") { value }

4. Pagination:
   - For "how many" questions: first: 250 (max per query)
   - For "show me" questions: first: 10-20
   - Never fetch all metafields - only what's needed

QUERY EXAMPLES:

PSA 10 Pikachu cards (count):
query { products(first: 250, query: "product_type:Singles AND title:*pikachu*") { edges { node { id title variants(first: 1) { edges { node { inventoryQuantity sku } } } grading: metafield(namespace: "custom", key: "Grading") { value } grade: metafield(namespace: "custom", key: "Grade") { value } } } } }

Sealed hobby boxes from 2022 Baseball:
query { products(first: 250, query: "product_type:Sealed AND title:*baseball*") { edges { node { id title variants(first: 1) { edges { node { inventoryQuantity price } } } waxtype: metafield(namespace: "custom", key: "waxtype") { value } waxyear: metafield(namespace: "custom", key: "waxyear") { value } waxsport: metafield(namespace: "custom", key: "waxsport") { value } } } } }

Baseball cards by specific player:
query { products(first: 250, query: "product_type:Singles AND title:*trout*") { edges { node { id title variants(first: 1) { edges { node { inventoryQuantity } } } sport: metafield(namespace: "custom", key: "Sport") { value } player: metafield(namespace: "custom", key: "player_name") { value } team: metafield(namespace: "custom", key: "Team") { value } } } } }

Modern vs Vintage Pokemon singles:
query { products(first: 250, query: "product_type:Singles AND title:*pokemon*") { edges { node { id title variants(first: 1) { edges { node { inventoryQuantity } } } modern: metafield(namespace: "custom", key: "Modern") { value } game: metafield(namespace: "custom", key: "singlesgame") { value } } } } }

BGS graded cards:
query { products(first: 250, query: "product_type:Singles") { edges { node { id title variants(first: 1) { edges { node { inventoryQuantity } } } grading: metafield(namespace: "custom", key: "Grading") { value } grade: metafield(namespace: "custom", key: "Grade") { value } } } } }

CRITICAL RULES:
- Always use product_type filter first
- Fetch specific and relevant metafields based on user request, not all metafields
- Use aliases for metafields (grade:, player:, sport:)
- ProductConnection has NO totalCount field - count results in edges array
- For grade questions, ALWAYS fetch BOTH "Grading" and "Grade" metafields
- Title searches use wildcards: title:*keyword*

RESPONSE FORMAT: Return ONLY the GraphQL query string. No explanations, no markdown, no code blocks.`,
      messages: [{
        role: 'user',
        content: cleanMessage,
      }],
    });

    const graphqlQuery = queryResponse.content[0].text.trim();
    
    // Update status
    if (statusMessage && client && channelId && statusMessage.ts) {
      try {
        await client.chat.update({
          channel: channelId,
          ts: statusMessage.ts,
          text: '📦 Fetching data from Shopify...',
        });
      } catch (updateError) {
        console.error('Failed to update status:', updateError.message);
      }
    }
    
    // ========================================
    // GUARDRAIL 5: Block mutation queries
    // ========================================
    if (isMutationQuery(graphqlQuery)) {
      if (!ALLOWED_OPERATIONS.update || !isUserAdmin(userId)) {
        if (statusMessage && client && channelId && statusMessage.ts) {
          await client.chat.update({
            channel: channelId,
            ts: statusMessage.ts,
            text: '❌ This query would modify data. Mutations not allowed.',
          });
        } else {
          await say('❌ Mutations not allowed.');
        }
        return;
      }
    }
    
    console.log(`[${new Date().toISOString()}] User ${userId} query:`, graphqlQuery);
    
    // ========================================
    // STEP 2: Execute query on Shopify
    // ========================================
    const shopifyData = await queryShopify(graphqlQuery);
    
    // Update status
    if (statusMessage && client && channelId && statusMessage.ts) {
      try {
        await client.chat.update({
          channel: channelId,
          ts: statusMessage.ts,
          text: '✨ Formatting your results...',
        });
      } catch (updateError) {
        console.error('Failed to update status:', updateError.message);
      }
    }
    
    // Check for errors
    if (shopifyData.errors) {
      if (statusMessage && client && channelId && statusMessage.ts) {
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
    
    // ========================================
    // STEP 3: Format response with Claude
    // ========================================
    const formatResponse = await anthropic.messages.create({
      model: 'claude-3-5-haiku-latest',
      max_tokens: 2048,
      system: `You are a helpful assistant formatting Shopify product data for a trading card store.

FORMAT GUIDELINES:
- Easy to read with bullet points
- Include emojis: 📦 products, 💰 prices, 📊 inventory, ⭐ grades
- Use *bold* for important info (prices, grades, inventory counts)
- Keep it concise and scannable
- Maximum 10 items per response (mention if there are more)
- For "how many" questions: Lead with the TOTAL COUNT in bold
- For graded cards: Always show grading company AND grade together

RESPONSE PATTERNS:

For counting queries:
Found *12 products* matching your search:
• Product Name - SKU: ABC123 - Stock: 5 units - PSA 10 - $299.99
• Product Name 2 - SKU: DEF456 - Stock: 0 units - BGS 9.5 - $149.99

For inventory queries:
📊 *Inventory Status*
• Product Name - *15 units* in stock - $49.99
• Product Name 2 - *Out of stock* - $29.99

For sealed products:
📦 *Sealed Products*
• 2022 Baseball Hobby Box - Manufacturer: Topps - Stock: 8 boxes - $89.99
• 2023 Basketball Blaster - Manufacturer: Panini - Stock: 3 boxes - $39.99`,
      messages: [{
        role: 'user',
        content: `User asked: "${cleanMessage}"\n\nShopify data:\n${JSON.stringify(shopifyData.data, null, 2)}\n\nFormat this for Slack.`,
      }],
    });

    const formattedResponse = formatResponse.content[0].text;
    
    // Delete status message
    if (statusMessage && client && channelId && statusMessage.ts) {
      try {
        await client.chat.delete({
          channel: channelId,
          ts: statusMessage.ts,
        });
      } catch (deleteError) {
        console.error('Failed to delete status:', deleteError.message);
      }
    }
    
    // Send final response
    await say(formattedResponse);
    
  } catch (error) {
    console.error('Error:', error);
    
    if (statusMessage && client && channelId && statusMessage.ts) {
      await client.chat.update({
        channel: channelId,
        ts: statusMessage.ts,
        text: `❌ Error: ${error.message}`,
      });
    } else {
      await say(`❌ Error: ${error.message}`);
    }
  }
}

// ========================================
// START THE APP
// ========================================
(async () => {
  await app.start();
  console.log('⚡️ Shopify AI Assistant is running!');
  console.log('Guardrails enabled:');
  console.log(`  - User whitelist: ${ALLOWED_USERS.length > 0 ? 'Yes' : 'No (all allowed)'}`);
  console.log(`  - Admin users: ${ADMIN_USERS.length}`);
  console.log(`  - Write operations: ${ALLOWED_OPERATIONS.update ? 'Enabled' : 'Disabled'}`);
  console.log(`  - Rate limit: ${RATE_LIMIT.maxRequests} requests per ${RATE_LIMIT.windowMs/1000} seconds`);
})();

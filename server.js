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

const ALLOWED_OPERATIONS = {
  read: true,
  update: false,
  create: false,
  delete: false,
};

const RATE_LIMIT = {
  maxRequests: 10,
  windowMs: 60000,
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
    
    if (containsSensitiveOperation(cleanMessage)) {
      await say('⚠️ This is a sensitive operation. Type "CONFIRM" or "CANCEL"');
    }
    
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
    
    if (!anthropic || !anthropic.messages) {
      throw new Error('Anthropic SDK is not properly initialized');
    }
    
    const queryResponse = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      system: `You are a Shopify GraphQL expert. Convert natural language questions into valid Shopify GraphQL queries.

IMPORTANT RESTRICTIONS:
- ONLY generate READ queries (no mutations)
- Use "query" keyword, NOT "mutation"
- Focus on: products, productVariants, inventory lookups

Examples:
- "show products under $50" → query { products(first: 50, query: "variants.price:<50") { edges { node { id title variants(first: 1) { edges { node { price } } } } } } }
- "inventory for SKU-123" → query { productVariants(first: 10, query: "sku:SKU-123") { edges { node { sku inventoryQuantity product { title } } } } }

Only return the GraphQL query string, nothing else.`,
      messages: [{
        role: 'user',
        content: cleanMessage,
      }],
    });

    const graphqlQuery = queryResponse.content[0].text.trim();
    
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
    
    const shopifyData = await queryShopify(graphqlQuery);
    
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
    
    const formatResponse = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 2048,
      system: `You are a helpful assistant formatting Shopify data for Slack.

Make the response:
- Easy to read with bullet points
- Include relevant emojis
- Highlight important info (prices, inventory)
- Keep it concise
- Use Slack formatting (*bold*)
- Maximum 10 items per response`,
      messages: [{
        role: 'user',
        content: `User asked: "${cleanMessage}"\n\nShopify data:\n${JSON.stringify(shopifyData.data, null, 2)}\n\nFormat this for Slack.`,
      }],
    });

    const formattedResponse = formatResponse.content[0].text;
    
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

(async () => {
  await app.start();
  console.log('⚡️ Shopify AI Assistant is running!');
  console.log('Guardrails enabled:');
  console.log(`  - User whitelist: ${ALLOWED_USERS.length > 0 ? 'Yes' : 'No (all allowed)'}`);
  console.log(`  - Admin users: ${ADMIN_USERS.length}`);
  console.log(`  - Write operations: ${ALLOWED_OPERATIONS.update ? 'Enabled' : 'Disabled'}`);
  console.log(`  - Rate limit: ${RATE_LIMIT.maxRequests} requests per ${RATE_LIMIT.windowMs/1000} seconds`);
})();

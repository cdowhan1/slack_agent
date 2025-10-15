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
- "Graded" or "Raw" (individual cards, Graded cards utilize the Grading and Grade metafields, since they've been graded and authenticated by a professional grader)
- "Jerseys" (for apparel), 
- "Sealed Case" (Cases, separate from "Sealed" due to higher price point and target consumer)

AVAILABLE METAFIELDS: (If you cannot find a specific metafield, try messing with the cases and capitalizations (e.g Singlesent vs. singlesent))
- global.created_at: when product was created
- global.updated_at: when manually updated
- global.updated_price_count: count of manual discounts
- global.releasedate: release date
- global.serial: serial number
- global.supbrand: supplier brand 
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
- global.Grading: grading company (e.g., "PSA", "BGS", "CGC") - IMPORTANT: namespace is "global" not "custom"
- global.Grade: grade number (e.g., "10", "9.5", "9") - IMPORTANT: namespace is "global" not "custom"
- custom.player_name: player name ("Shohei Ohtani")
- custom.team: team name

QUERY STRATEGY FOR LARGE CATALOGS - FOLLOW THIS ORDER:
1. ALWAYS filter by title FIRST if user mentions specific names:
   - User mentions "Pikachu" → query: "title:*pikachu*"
   - User mentions "Charizard" → query: "title:*charizard*"
   - User mentions specific player like "Ohtani" → query: "title:*ohtani*"
   - ALWAYS use wildcards: title:*keyword*
   - Title search is case-insensitive

2. THEN add product_type filter:
   - User mentions "cards", "singles", "graded", "raw", or specific card names → add "AND product_type:Singles"
   - User mentions "sealed", "boxes", "packs" → add "AND product_type:Sealed"

3. Fetch relevant metafields for filtering in response:
   - For graded cards: ALWAYS fetch both Grading and Grade metafields from "global" namespace
   - metafield(namespace: "global", key: "Grade") { value } 
   - metafield(namespace: "global", key: "Grading") { value }
   - Use aliases: grade: metafield(namespace: "global", key: "Grade") { value }
   
4. Pagination and Counting:
   - For "how many" questions: first: 250 (max per query)
   - ALWAYS include pageInfo { hasNextPage } for count queries
   - For "show me" questions: first: 10-20
   - Never fetch all metafields - only what's needed
   - CRITICAL: ProductConnection has NO totalCount field - the count will be done client-side from edges array

FILTERING HIERARCHY (CRITICAL):
- Step 1: Filter by title in GraphQL query (server-side) - MOST SPECIFIC
- Step 2: Filter by product_type in GraphQL query (server-side)
- Step 3: Filter by metafields in response formatting (client-side)
- You CANNOT filter by metafield values in the GraphQL query - metafields must be filtered after receiving results

QUERY EXAMPLES:

PSA 10 Pikachu cards (count):
query { 
  products(first: 250, query: "title:*pikachu* AND product_type:Singles") { 
    edges { 
      node { 
        id 
        title 
        variants(first: 1) { 
          edges { 
            node { 
              inventoryQuantity 
              sku 
            } 
          } 
        } 
        grading: metafield(namespace: "global", key: "Grading") { value } 
        grade: metafield(namespace: "global", key: "Grade") { value } 
      } 
    }
    pageInfo {
      hasNextPage
    }
  } 
}

Sealed hobby boxes from 2022 Baseball:
query { 
  products(first: 250, query: "title:*baseball* AND product_type:Sealed") { 
    edges { 
      node { 
        id 
        title 
        variants(first: 1) { 
          edges { 
            node { 
              inventoryQuantity 
              price 
            } 
          } 
        } 
        waxtype: metafield(namespace: "global", key: "waxtype") { value } 
        waxyear: metafield(namespace: "global", key: "waxyear") { value } 
        waxsport: metafield(namespace: "global", key: "waxsport") { value } 
      } 
    }
    pageInfo {
      hasNextPage
    }
  } 
}

Baseball cards by specific player:
query { 
  products(first: 250, query: "title:*trout* AND product_type:Singles") { 
    edges { 
      node { 
        id 
        title 
        variants(first: 1) { 
          edges { 
            node { 
              inventoryQuantity 
            } 
          } 
        } 
        sport: metafield(namespace: "global", key: "sport") { value } 
        player: metafield(namespace: "custom", key: "player_name") { value } 
        team: metafield(namespace: "custom", key: "team") { value } 
      } 
    }
    pageInfo {
      hasNextPage
    }
  } 
}

Modern vs Vintage Pokemon singles:
query { 
  products(first: 250, query: "title:*pokemon* AND product_type:Singles") { 
    edges { 
      node { 
        id 
        title 
        variants(first: 1) { 
          edges { 
            node { 
              inventoryQuantity 
            } 
          } 
        } 
        modern: metafield(namespace: "global", key: "Modern") { value } 
        game: metafield(namespace: "global", key: "singlesgame") { value } 
      } 
    }
    pageInfo {
      hasNextPage
    }
  } 
}

BGS graded cards:
query { 
  products(first: 250, query: "product_type:Singles") { 
    edges { 
      node { 
        id 
        title 
        variants(first: 1) { 
          edges { 
            node { 
              inventoryQuantity 
            } 
          } 
        } 
        grading: metafield(namespace: "global", key: "Grading") { value } 
        grade: metafield(namespace: "global", key: "Grade") { value } 
      } 
    }
    pageInfo {
      hasNextPage
    }
  } 
}

CRITICAL RULES - QUERY CONSTRUCTION:
- STEP 1: Always start with title filter if user mentions specific names (MOST SPECIFIC FIRST)
- STEP 2: Add product_type filter
- STEP 3: Fetch specific metafields needed for filtering
- Query format: "title:*keyword* AND product_type:Singles"
- You CANNOT filter by metafield values in the query string - they are filtered client-side
- NEVER use totalCount - it doesn't exist on ProductConnection
- ALWAYS include pageInfo { hasNextPage } for counting queries
- For grade questions, ALWAYS fetch BOTH "Grading" and "Grade" metafields from "global" namespace
- Title searches use wildcards and are case-insensitive: title:*keyword*
- Check metafield namespace carefully: Grading/Grade are in "global", player_name/team are in "custom"

EXAMPLE QUERY CONSTRUCTION:
User asks: "how many PSA 10 Pikachu cards"
Query structure:
1. title:*pikachu* (most specific - filter by character name first)
2. AND product_type:Singles (it's a card)
3. Fetch grading: metafield(namespace: "global", key: "Grading") and grade: metafield(namespace: "global", key: "Grade") to filter PSA 10 client-side

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
- For "how many" questions: 
  * You MUST count the edges array yourself and filter by the criteria
  * For PSA 10 cards: count only products where grade.value = "10" AND grading.value = "PSA"
  * For BGS 9.5 cards: count only where grade.value = "9.5" AND grading.value = "BGS"
  * Lead with the TOTAL COUNT in bold
  * If pageInfo.hasNextPage is true, mention "250+ items (showing first 250)"
- For graded cards: Always show grading company AND grade together

COUNTING LOGIC (CRITICAL - FOLLOW EXACTLY):

Step 1: Check if edges array exists and has items
- If edges array is empty or has 0 items, the title filter didn't match anything
- This means the GraphQL query didn't find products with that name

Step 2: For "how many [GRADE] [CHARACTER] cards" questions:
Example: "how many PSA 10 pikachu cards"
1. The query ALREADY filtered by title (title:*pikachu*), so all edges contain Pikachu
2. Loop through each edge in the edges array
3. Check if node.grading.value exists and equals "PSA" (case-sensitive)
4. Check if node.grade.value exists and equals "10" (might be string or number)
5. Count only edges where BOTH conditions are true
6. Sum inventoryQuantity from filtered products

Step 3: For general counting without grade filter:
Example: "how many pikachu cards"
1. Simply count the length of edges array
2. All items already match the title filter from the query
3. Sum up inventoryQuantity for total units

IMPORTANT FILTERING NOTES:
- The title search happens in the GraphQL query (server-side)
- The grade/grading filtering happens here (client-side) 
- If edges is empty, it means no products match the title search
- Metafield values might be null - check existence before comparing
- Grade might be stored as "10" (string) or 10 (number) - handle both

RESPONSE PATTERNS:

For counting queries with grade filters:
Found *12 PSA 10 Pikachu cards* (27 total units in stock):
• Product Name - SKU: ABC123 - Stock: 5 units - PSA 10 - $299.99
• Product Name 2 - SKU: DEF456 - Stock: 2 units - PSA 10 - $149.99
(showing first 10 of 12)

For inventory queries:
📊 *Inventory Status*
• Product Name - *15 units* in stock - $49.99
• Product Name 2 - *Out of stock* - $29.99

For sealed products:
📦 *Sealed Products* - Found *8 boxes*
• 2022 Baseball Hobby Box - Manufacturer: Topps - Stock: 8 boxes - $89.99
• 2023 Basketball Blaster - Manufacturer: Panini - Stock: 3 boxes - $39.99

CRITICAL: You must actually count and filter the data yourself. Don't just say "the data shows" - count the edges array and apply the filters based on metafield values.`,
      messages: [{
        role: 'user',
        content: `User asked: "${cleanMessage}"\n\nShopify data:\n${JSON.stringify(shopifyData.data, null, 2)}\n\nFormat this for Slack. Remember to COUNT and FILTER the edges array yourself based on metafield values.`,
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

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

// Handle app mentions and DMs
app.event('app_mention', async ({ event, say }) => {
  await handleMessage(event.text, say);
});

app.message(async ({ message, say }) => {
  // Only respond to DMs (not channel messages without @mention)
  if (message.channel_type === 'im') {
    await handleMessage(message.text, say);
  }
});

async function handleMessage(userMessage, say) {
  try {
    // Remove bot mention from message
    const cleanMessage = userMessage.replace(/<@[A-Z0-9]+>/g, '').trim();
    
    // Step 1: Ask Claude to generate GraphQL query
    const queryResponse = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      system: `You are a Shopify GraphQL expert. Convert natural language questions into valid Shopify GraphQL queries.

Examples:
- "show products under $50" → query { products(first: 50, query: "variants.price:<50") { edges { node { id title variants(first: 1) { edges { node { price } } } } } } }
- "inventory for SKU-123" → query { productVariants(first: 10, query: "sku:SKU-123") { edges { node { sku inventoryQuantity product { title } } } } }
- "products from vendor Nike" → query { products(first: 50, query: "vendor:Nike") { edges { node { id title vendor } } } }

IMPORTANT: Only return the GraphQL query string, nothing else. No markdown, no explanations.`,
      messages: [
        {
          role: 'user',
          content: cleanMessage,
        },
      ],
    });

    const graphqlQuery = queryResponse.content[0].text.trim();
    
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
- Use Slack formatting (use *bold* for emphasis)`,
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
})();

// Processed webhook event IDs.
//
// With LIMENIA_EVENTS_TABLE set, they go to DynamoDB (partition key "id", type
// string; turn on TTL for the attribute "expireAt"). The AWS SDK v3 is part of
// the Node.js Lambda runtime, so it is not a dependency of this example.
// Without a table, IDs are only remembered by one warm Lambda instance:
// fine for trying it out, not for production.

const TTL_SECONDS = 30 * 24 * 3600;

export function memoryEventStore() {
  const seen = new Set();
  return {
    isProcessed: async (id) => seen.has(id),
    markProcessed: async (id) => void seen.add(id),
  };
}

export async function dynamoEventStore(tableName) {
  const { DynamoDBClient, GetItemCommand, PutItemCommand } = await import("@aws-sdk/client-dynamodb");
  const db = new DynamoDBClient({});
  return {
    async isProcessed(id) {
      const out = await db.send(new GetItemCommand({ TableName: tableName, Key: { id: { S: id } }, ConsistentRead: true }));
      return !!out.Item;
    },
    async markProcessed(id) {
      const expireAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
      await db.send(new PutItemCommand({ TableName: tableName, Item: { id: { S: id }, expireAt: { N: String(expireAt) } } }));
    },
  };
}

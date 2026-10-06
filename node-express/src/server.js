import { actions } from "./actions.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { LimeniaClient } from "./limenia.js";

const config = loadConfig();
const limenia = new LimeniaClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
const app = createApp({ limenia, webhookSecrets: config.webhookSecrets, actions });

app.listen(config.port, () => {
  console.log(JSON.stringify({ msg: "listening", port: config.port }));
});

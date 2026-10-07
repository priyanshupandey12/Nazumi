import 'dotenv/config'
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { attachChatServer } from './chat/chat.server.js';

const app = createApp();

// An explicit HTTP server, so the WebSocket layer can share the same port and
// the same origin as the API — which keeps the session cookie in play.
const server = createServer(app);

attachChatServer(server);

server.listen(process.env.PORT, () => {
    console.log(`Server is running on port ${process.env.PORT}`);
});

import 'dotenv/config'
import { createApp } from './app.js';

const app = createApp();

app.listen(process.env.PORT, () => {
    console.log(`Server is running on port ${process.env.PORT}`);
});

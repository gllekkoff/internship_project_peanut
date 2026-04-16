import { config } from '@/configs/configs.service';

const port = config.chain.port;

console.log(`Running on port ${port}`);

export const greet = (name: string): string => `Hello, ${name}!`;

console.log(greet('world'));

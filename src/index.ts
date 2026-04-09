import { config } from '@/core/core.config';

const port = config.port;

console.log(`Running on port ${port}`);

export const greet = (name: string): string => `Hello, ${name}!`;

console.log(greet('world'));

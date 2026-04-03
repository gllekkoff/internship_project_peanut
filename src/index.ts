import 'dotenv/config';

const port = process.env['PORT'] ?? 3000;

console.log(`Running on port ${port}`);

export const greet = (name: string): string => `Hello, ${name}!`;

console.log(greet('world'));

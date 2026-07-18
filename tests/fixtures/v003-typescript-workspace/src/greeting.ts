export interface Greeting {
  message: string;
}

export function createGreeting(name: string): Greeting {
  return { message: `Hello, ${name}` };
}

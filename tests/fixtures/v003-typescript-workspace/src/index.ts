import { createGreeting } from "@fixture/greeting";

export class FixtureApplication {
  run(name: string): string {
    return createGreeting(name).message;
  }
}

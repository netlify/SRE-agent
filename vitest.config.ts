import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    testTimeout: 30000,
    env: {
      SLACK_BOT_TOKEN: "xoxb-test",
      ANTHROPIC_API_KEY: "sk-test",
      NODE_ENV: "test",
    },
  },
});

import { startWorkflowMcpServer } from "./workflow-server.ts";

try {
  await startWorkflowMcpServer();
} catch {
  process.exitCode = 1;
}

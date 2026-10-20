// Engineering pack control plane (read-only except `promote`/`revoke`, which apply a pre-signed grant). See
// src/runtime/knowledge/engineering-cli.ts for the command list.
//
//   npm run engineering -- status [--json] [--probe-ollama]
//   npm run engineering -- agents | skills | validate | drift [--strict]
//   npm run engineering -- render claude-code <agent-id>
//   npm run engineering -- promote|revoke <skill-id> --grant <signed-grant.json>
import { runEngineeringCli } from '../src/runtime/knowledge/engineering-cli.ts';

process.exitCode = await runEngineeringCli(process.argv.slice(2), { out: (t) => console.log(t), err: (t) => console.error(t) });

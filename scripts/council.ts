// Engineering council (M11.x): three read-only Mastra specialists, one bounded meeting, one durable record.
//
//   npm run council -- status [--probe] [--json]
//   npm run council -- run [--live] [--meeting-id ID] [--question TEXT] [--in-process] [--server URL]
//   npm run council -- show ID [--json]
//
// See docs/operations/engineering-council-demo.md.
import { runCouncilCli } from '../src/integrations/mastra/council/cli.ts';

process.exitCode = await runCouncilCli(process.argv.slice(2), { out: (t) => console.log(t), err: (t) => console.error(t) });

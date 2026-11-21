// Print starter prompts for agents.
//   npm run starters                 list all starters
//   npm run starters -- <id>         print one starter as a ready-to-use prompt
//   npm run starters -- --random [--max-risk low|medium|high] [--archetype <a>]
import { STARTERS, pickStarter, renderStarter, type StarterRisk, type StarterPrompt } from '../src/shared/starters.ts';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

if (args.includes('--random')) {
  console.log(renderStarter(pickStarter({ maxRisk: flag('--max-risk') as StarterRisk | undefined, archetype: flag('--archetype') as StarterPrompt['archetype'] | undefined })));
} else if (args[0] && !args[0].startsWith('--')) {
  console.log(renderStarter(pickStarter({ id: args[0] })));
} else {
  for (const s of STARTERS) console.log(`${s.id.padEnd(22)} ${s.archetype.padEnd(9)} ${s.risk.padEnd(7)} ${s.summary}`);
}

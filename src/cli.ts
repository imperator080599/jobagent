// Ligne de commande d'exploitation.
//   npm run cli -- migrate | tick | work | help
import { getRuntime } from './runtime.js';
import { errorMessage } from './core/log.js';

type Command = (args: string[]) => Promise<void>;
const commands = new Map<string, { help: string; run: Command }>();

export function registerCommand(name: string, help: string, run: Command) {
  commands.set(name, { help, run });
}

registerCommand('migrate', 'Applique les migrations de la base de données', async () => {
  const { handle } = await getRuntime({ migrate: true });
  console.log(`Migrations appliquées (${handle.kind}).`);
});

registerCommand('tick', 'Exécute un tick du planificateur puis vide la file de tâches', async () => {
  const { ctx } = await getRuntime({ migrate: true });
  const { schedulerTick } = await import('./pipeline/scheduler.js');
  const { runWorker } = await import('./pipeline/worker.js');
  const t = await schedulerTick(ctx);
  const w = await runWorker(ctx, { budgetMs: 15 * 60_000, workerId: 'cli' });
  console.log(JSON.stringify({ scheduler: t, worker: w }, null, 2));
});

async function main() {
  const [name = 'help', ...args] = process.argv.slice(2);
  await import('./cli-commands.js');
  const cmd = commands.get(name);
  if (!cmd) {
    console.log('Commandes disponibles :');
    for (const [n, c] of commands) console.log(`  ${n.padEnd(18)} ${c.help}`);
    process.exit(name === 'help' ? 0 : 1);
  }
  await cmd.run(args);
  const { handle } = await getRuntime();
  await handle.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(errorMessage(err));
  process.exit(1);
});

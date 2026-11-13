// Commandes d'exploitation enregistrées par les modules.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createUser, normalizeEmail } from './auth/service.js';
import { registerCommand } from './cli.js';
import { forUser } from './core/context.js';
import { sha256 } from './core/crypto.js';
import { files, users } from './db/schema.js';
import { importLetterTemplate, listTemplates } from './docs/templates.js';
import { saveAtsPrompt } from './profile/ats-prompt.js';
import { bootstrapUser } from './profile/bootstrap.js';
import { importCv, listCvVersions } from './profile/cv.js';
import { setFact } from './profile/facts.js';
import { getRuntime } from './runtime.js';

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/**
 * Charge dans une instance les documents personnels déposés dans un dossier privé
 * (jamais commité) : CV master, modèle de lettre, prompt ATS, coordonnées.
 * Rejouable sans doublon. Le CV reste un brouillon : c'est l'utilisateur qui le valide.
 */
registerCommand('seed-private', 'Charge les documents du dossier ./private (--email compte [--password …] [--dir private])', async (args) => {
  const { ctx } = await getRuntime({ migrate: true });
  const dir = path.resolve(arg(args, 'dir') ?? 'private');
  const email = arg(args, 'email');
  if (!email) throw new Error('Précisez le compte : --email adresse@exemple.com');
  if (!existsSync(dir)) throw new Error(`Dossier introuvable : ${dir}`);

  let [user] = await ctx.db.select().from(users).where(eq(users.email, normalizeEmail(email)));
  if (!user) {
    const password = arg(args, 'password') ?? process.env.SEED_PASSWORD;
    if (!password) throw new Error("Ce compte n'existe pas. Créez-le dans l'application, ou fournissez --password pour le créer.");
    const [any] = await ctx.db.select({ id: users.id }).from(users).limit(1);
    user = await createUser(ctx.db, { email, password, role: any ? 'user' : 'owner' });
    await bootstrapUser(ctx, user.id);
    console.log(`Compte créé : ${user.email}`);
  }
  const uctx = forUser(ctx, user.id);
  const have = new Set((await ctx.db.select({ sha: files.sha256 }).from(files).where(eq(files.userId, user.id))).map((f) => f.sha));
  const read = (name: string) => (existsSync(path.join(dir, name)) ? new Uint8Array(readFileSync(path.join(dir, name))) : null);

  const profile = read('profile.json');
  if (profile) {
    const p = JSON.parse(Buffer.from(profile).toString('utf8')) as { applicationEmail?: string; linkedinUrl?: string; name?: string };
    if (p.applicationEmail) await setFact(ctx.db, user.id, { key: 'contact.email', value: p.applicationEmail, source: 'user', sourceRef: 'configuration initiale' });
    if (p.linkedinUrl) await setFact(ctx.db, user.id, { key: 'contact.linkedin_url', value: p.linkedinUrl, source: 'user', sourceRef: 'configuration initiale' });
    console.log('Coordonnées enregistrées.');
  }

  const prompt = read('ats-prompt.txt');
  if (prompt) {
    const res = await saveAtsPrompt(uctx, Buffer.from(prompt).toString('utf8'), 'Prompt ATS personnel (configuration initiale)');
    console.log(res.created ? `Prompt ATS enregistré (version ${res.prompt.version}).` : 'Prompt ATS déjà à jour.');
  }

  for (const name of ['letter-template.docx', 'letter-template.rtf']) {
    const data = read(name);
    if (!data) continue;
    if (have.has(sha256(data))) console.log('Modèle de lettre déjà importé.');
    else {
      const t = await importLetterTemplate(uctx, { filename: name === 'letter-template.rtf' ? 'Cover_letter_template.rtf' : 'Cover_letter_template.docx', mime: '', data });
      console.log(`Modèle de lettre importé (version ${t.version}, ${(await listTemplates(ctx.db, user.id, 'letter')).length} version(s)).`);
    }
    break;
  }

  for (const name of ['cv-master.docx', 'cv-master-en.docx', 'cv-master.pdf', 'cv-master-en.pdf', 'cv-master-fr.pdf']) {
    const data = read(name);
    if (!data) continue;
    if (have.has(sha256(data))) {
      console.log(`CV déjà importé (${name}).`);
      continue;
    }
    const res = await importCv(uctx, { filename: name, mime: name.endsWith('.pdf') ? 'application/pdf' : '', data });
    console.log(`CV importé en brouillon (${name}, structuration : ${res.method}) — à relire et valider dans l'application.`);
    for (const w of res.warnings) console.log(`  ! ${w}`);
  }
  const drafts = (await listCvVersions(ctx.db, user.id, { kinds: ['master'] })).filter((v) => v.status === 'draft').length;
  console.log(`Terminé. ${drafts} brouillon(s) de CV master en attente de validation.`);
});

registerCommand('export', "Exporte toutes les données d'un compte dans un fichier JSON (--email compte --out fichier [--files])", async (args) => {
  const { ctx } = await getRuntime({ migrate: true });
  const email = arg(args, 'email');
  const out = arg(args, 'out');
  if (!email || !out) throw new Error('Usage : export --email adresse@exemple.com --out sauvegarde.json [--files]');
  const { users } = await import('./db/schema.js');
  const { eq } = await import('drizzle-orm');
  const { forUser } = await import('./core/context.js');
  const { exportUserData } = await import('./core/export.js');
  const { writeFileSync } = await import('node:fs');
  const [user] = await ctx.db.select().from(users).where(eq(users.email, email.trim().toLowerCase()));
  if (!user) throw new Error(`Compte introuvable : ${email}`);
  const data = await exportUserData(forUser(ctx, user.id), { files: args.includes('--files') });
  writeFileSync(path.resolve(out), JSON.stringify(data));
  console.log(`Export écrit dans ${path.resolve(out)} (${Object.keys(data).length} rubriques, ${(data.jobs as unknown[]).length} offres).`);
});

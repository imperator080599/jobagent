// Usages épistolaires par langue et par pays : formule d'appel, formule de
// politesse, format de date. Règles fixes — aucune IA n'est nécessaire ici.

export type LetterLanguage = 'fr' | 'en' | 'es' | 'de';

const MONTHS: Record<LetterLanguage, string[]> = {
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
};

const US_STYLE = new Set(['US', 'CA']);

export function letterLanguage(code: string | undefined): LetterLanguage {
  return code === 'en' || code === 'es' || code === 'de' ? code : code === 'fr' ? 'fr' : 'en';
}

export function formatLetterDate(date: Date, lang: LetterLanguage, country = '', city = ''): string {
  const d = date.getUTCDate();
  const m = MONTHS[lang][date.getUTCMonth()]!;
  const y = date.getUTCFullYear();
  switch (lang) {
    case 'fr':
      return `${city ? `${city}, le ` : 'Le '}${d === 1 ? '1er' : d} ${m} ${y}`;
    case 'es':
      return `${city ? `${city}, ` : ''}${d} de ${m} de ${y}`;
    case 'de':
      return `${city ? `${city}, ` : ''}${d}. ${m} ${y}`;
    default:
      return US_STYLE.has(country.toUpperCase()) ? `${m} ${d}, ${y}` : `${d} ${m} ${y}`;
  }
}

export interface Recipient {
  /** Nom complet du destinataire, s'il est connu avec certitude. Jamais inventé. */
  name?: string;
  /** Civilité connue (jamais déduite du prénom). */
  civility?: 'mr' | 'ms';
}

function lastName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1] ?? name;
}

/** Formule d'appel. Sans destinataire connu, la formule neutre d'usage est employée. */
export function salutation(lang: LetterLanguage, r: Recipient = {}): string {
  const name = r.name?.trim();
  switch (lang) {
    case 'fr':
      if (name && r.civility) return `${r.civility === 'mr' ? 'Monsieur' : 'Madame'} ${lastName(name)},`;
      return 'Madame, Monsieur,';
    case 'es':
      if (name && r.civility) return `${r.civility === 'mr' ? 'Estimado Sr.' : 'Estimada Sra.'} ${lastName(name)}:`;
      return 'Estimados señores:';
    case 'de':
      if (name && r.civility) return `${r.civility === 'mr' ? 'Sehr geehrter Herr' : 'Sehr geehrte Frau'} ${lastName(name)},`;
      return 'Sehr geehrte Damen und Herren,';
    default:
      if (name && r.civility) return `Dear ${r.civility === 'mr' ? 'Mr' : 'Ms'} ${lastName(name)},`;
      if (name) return `Dear ${name},`;
      return 'Dear Hiring Manager,';
  }
}

/** Formule de politesse finale, selon la langue, le pays et le fait que le destinataire soit nommé. */
export function closing(lang: LetterLanguage, country = '', named = false): string {
  switch (lang) {
    case 'fr':
      return "Je vous prie d'agréer, Madame, Monsieur, l'expression de mes salutations distinguées.";
    case 'es':
      return 'Atentamente,';
    case 'de':
      return 'Mit freundlichen Grüßen';
    default:
      if (US_STYLE.has(country.toUpperCase())) return 'Sincerely,';
      return named ? 'Yours sincerely,' : 'Yours faithfully,';
  }
}

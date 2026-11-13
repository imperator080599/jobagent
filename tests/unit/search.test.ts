import { describe, expect, it } from 'vitest';
import { canonicalUrl, companyKey, detectContract, detectSeniority, extractYears, fingerprint, htmlToText, inferLocation, parseLocation, titleKey } from '../../src/search/normalize.js';
import { parseRobots, robotsAllows } from '../../src/search/http.js';
import { findJobPostings, readJobPage } from '../../src/search/page.js';
import { guessJobFields } from '../../src/search/extract.js';

describe('adresse canonique', () => {
  it('retire les paramètres de suivi et reconnaît les plateformes', () => {
    expect(canonicalUrl('https://boards.greenhouse.io/acme/jobs/4512345?gh_src=abc123&utm_source=linkedin')).toEqual({ url: 'https://job-boards.greenhouse.io/acme/jobs/4512345', ref: 'gh:4512345' });
    expect(canonicalUrl('https://job-boards.greenhouse.io/Acme/jobs/4512345')).toEqual({ url: 'https://job-boards.greenhouse.io/acme/jobs/4512345', ref: 'gh:4512345' });
    expect(canonicalUrl('https://jobs.lever.co/acme/1b2c3d4e-aaaa-bbbb-cccc-1234567890ab/apply?lever-source=LinkedIn').ref).toBe('lever:1b2c3d4e-aaaa-bbbb-cccc-1234567890ab');
    expect(canonicalUrl('https://www.linkedin.com/jobs/view/senior-analyst-at-acme-3812345678/?trk=public_jobs&refId=xyz').url).toBe('https://www.linkedin.com/jobs/view/3812345678');
    expect(canonicalUrl('https://www.linkedin.com/comm/jobs/view/3812345678/?trackingId=abc&refId=x').url).toBe('https://www.linkedin.com/jobs/view/3812345678');
    expect(canonicalUrl('https://fr.indeed.com/viewjob?jk=abc123def&from=serp&vjs=3')).toEqual({ url: 'https://fr.indeed.com/viewjob?jk=abc123def', ref: 'indeed:abc123def' });
  });

  it('donne la même adresse à deux liens vers la même page', () => {
    const a = canonicalUrl('https://www.example.com/careers/job/12345/?utm_campaign=x&ref=home');
    const b = canonicalUrl('https://example.com/careers/job/12345');
    expect(a.url).toBe(b.url);
    expect(canonicalUrl('https://careers.example.com/?gh_jid=778899&gh_src=q').ref).toBe('gh:778899');
  });

  it('refuse ce qui n’est pas une adresse web', () => {
    expect(canonicalUrl('javascript:alert(1)').url).toBe('');
    expect(canonicalUrl('pas une url').url).toBe('');
  });
});

describe('entreprise et intitulé', () => {
  it('ignore la forme juridique, la casse, les accents et le pays', () => {
    expect(companyKey('Mazars France')).toBe(companyKey('MAZARS'));
    expect(companyKey('Société Générale SA')).toBe(companyKey('Societe Generale'));
    expect(companyKey('Ernst & Young')).toBe(companyKey('Ernst and Young LLP'));
    expect(companyKey('Rothschild & Co')).toBe(companyKey('Rothschild and Co'));
    expect(companyKey('NORTHWIND CAPITAL S.A.')).toBe(companyKey('Northwind Capital'));
    expect(companyKey('Hartwell & Associés')).toBe(companyKey('HARTWELL ET ASSOCIES'));
    expect(companyKey('Mazars S.à r.l.')).toBe(companyKey('Mazars'));
    expect(companyKey('H&M')).toBe('h&m');
    expect(companyKey('Acme Group')).not.toBe(companyKey('Apex Group'));
  });

  it('ignore le genre, le contrat, l’année et le lieu répété', () => {
    const a = titleKey('Analyste Transaction Services (H/F) - CDI - Paris', 'Paris, France');
    const b = titleKey('Analyste Transaction Services F/H', 'Paris');
    expect(a).toBe(b);
    expect(titleKey('Senior Associate, Transaction Services (m/w/d) 2026')).toBe(titleKey('Senior Associate, Transaction Services'));
    expect(titleKey('Analyst M&A')).not.toBe(titleKey('Analyst Audit'));
  });

  it('produit la même empreinte pour deux diffusions de la même offre', () => {
    const paris = parseLocation('Paris, Île-de-France, France');
    const defense = parseLocation('Paris La Défense');
    expect(fingerprint('Grant Thornton France', 'Consultant Deal Advisory (H/F)', paris, 'Paris, Île-de-France, France')).toBe(fingerprint('Grant Thornton', 'Consultant Deal Advisory F/H - Paris', defense, 'Paris La Défense'));
    expect(fingerprint('Grant Thornton', 'Consultant Deal Advisory', paris)).not.toBe(fingerprint('Grant Thornton', 'Consultant Deal Advisory', parseLocation('Lyon')));
  });
});

describe('localisation', () => {
  it('reconnaît ville, pays et mode de travail', () => {
    expect(parseLocation('London, UK')).toEqual({ city: 'London', country: 'GB', remote: '' });
    expect(parseLocation('Luxembourg')).toEqual({ city: 'Luxembourg', country: 'LU', remote: '' });
    expect(parseLocation('Genève (Suisse) - Hybride')).toEqual({ city: 'Geneva', country: 'CH', remote: 'hybrid' });
    expect(parseLocation('Remote - France')).toMatchObject({ country: 'FR', remote: 'remote' });
    expect(parseLocation('Ho Chi Minh City, Vietnam')).toMatchObject({ city: 'Ho Chi Minh City', country: 'VN' });
    expect(parseLocation('Angers', 'France')).toEqual({ city: 'Angers', country: 'FR', remote: '' });
  });
});

describe('lieu déduit du texte', () => {
  it('retient un lieu annoncé explicitement et reconnu, rien d’autre', () => {
    expect(inferLocation('Poste en CDI, basé à Paris.')).toBe('Paris');
    expect(inferLocation('The role is based in London with occasional travel.')).toBe('London');
    expect(inferLocation('Location: Luxembourg, Luxembourg\nAbout us…')).toBe('Luxembourg, Luxembourg');
    expect(inferLocation('Lieu : La Défense (92)')).toBe('Paris');
    expect(inferLocation('Notre siège historique se trouve en région lyonnaise.')).toBe('');
    expect(inferLocation('Vous serez basé à Trifouillis-les-Oies.')).toBe('');
  });
});

describe('contrat, niveau, expérience', () => {
  it('lit le type de contrat dans l’intitulé puis dans le texte', () => {
    expect(detectContract('V.I.E - Financial Analyst')).toBe('vie');
    expect(detectContract('Stage - Analyste M&A (6 mois)')).toBe('internship');
    expect(detectContract('Alternance Contrôle de gestion')).toBe('apprenticeship');
    expect(detectContract('Financial Analyst', 'Nous proposons un CDI basé à Paris.')).toBe('cdi');
    expect(detectContract('Financial Analyst', 'Rejoignez une équipe internationale.')).toBe('');
    expect(detectContract('Senior Associate', 'Company: X\nLocation: Luxembourg\nContract: Permanent, full-time\n\nAbout the role')).toBe('cdi');
    // Un mot du corps de l'annonce ne suffit pas à requalifier un poste permanent.
    expect(detectContract('Senior Analyst - CDI', 'Vous encadrerez un stagiaire.')).toBe('cdi');
  });

  it('estime le niveau à partir de l’intitulé', () => {
    expect(detectSeniority('Senior Associate Transaction Services')).toBe('senior');
    expect(detectSeniority('Manager FP&A')).toBe('manager');
    expect(detectSeniority('Assistant Manager Audit')).toBe('senior');
    expect(detectSeniority('Stagiaire Corporate Finance')).toBe('intern');
    expect(detectSeniority('Analyst')).toBe('mid');
    expect(detectSeniority('Head of Finance')).toBe('director');
  });

  it('lit les années d’expérience demandées', () => {
    expect(extractYears('Vous justifiez de 3 à 5 ans d’expérience en audit.')).toEqual({ min: 3, max: 5 });
    expect(extractYears('At least 2 years of relevant experience')).toEqual({ min: 2, max: null });
    expect(extractYears('5+ years in transaction services')).toEqual({ min: 5, max: null });
    expect(extractYears('Fondée il y a 20 ans, notre société…')).toEqual({ min: null, max: null });
  });
});

describe('texte de l’offre', () => {
  it('convertit le HTML en texte lisible sans scripts', () => {
    const text = htmlToText('<div><h2>Missions</h2><ul><li>Analyser les comptes</li><li>R&eacute;diger &amp; présenter</li></ul><script>alert(1)</script><p>Profil&nbsp;: Bac+5</p></div>');
    expect(text).toContain('Missions');
    expect(text).toContain('- Analyser les comptes');
    expect(text).toContain('Rédiger & présenter');
    expect(text).toContain('Profil : Bac+5');
    expect(text).not.toContain('alert');
  });
});

describe('robots.txt', () => {
  it('applique la règle la plus précise', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/jobs/\n\nUser-agent: BadBot\nDisallow: /');
    expect(robotsAllows(rules, '/jobs/123')).toBe(true);
    expect(robotsAllows(rules, '/private/account')).toBe(false);
    expect(robotsAllows(rules, '/private/jobs/123')).toBe(true);
  });

  it('respecte une interdiction qui vise JobAgent ou tout le monde', () => {
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /'), '/jobs/1')).toBe(false);
    expect(robotsAllows(parseRobots('User-agent: JobAgent\nDisallow: /careers\n\nUser-agent: *\nDisallow:'), '/careers/1')).toBe(false);
    expect(robotsAllows(parseRobots('User-agent: *\nDisallow: /*?apply=$'), '/job/1?apply=')).toBe(false);
    expect(robotsAllows(parseRobots(''), '/anything')).toBe(true);
  });
});

const PAGE = `<!doctype html><html><head><title>Senior Analyst | Northwind Careers</title>
<meta property="og:site_name" content="Northwind Capital">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"Northwind"},
{"@type":"JobPosting","title":"Senior Analyst, Transaction Services","datePosted":"2026-10-28","validThrough":"2026-12-15T23:59",
"employmentType":"FULL_TIME","hiringOrganization":{"@type":"Organization","name":"Northwind Capital"},
"jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Luxembourg","addressCountry":"LU"}},
"baseSalary":{"@type":"MonetaryAmount","currency":"EUR","value":{"@type":"QuantitativeValue","minValue":65000,"maxValue":80000,"unitText":"YEAR"}},
"identifier":{"@type":"PropertyValue","name":"Northwind","value":"REQ-4471"},
"description":"<p>You will join our <b>Transaction Services</b> team.</p><ul><li>Financial due diligence</li><li>3 to 5 years of experience</li></ul>"}]}</script>
</head><body><nav>Menu</nav><main><h1>Senior Analyst, Transaction Services</h1><p>You will join our Transaction Services team.</p></main></body></html>`;

describe('lecture d’une page d’offre', () => {
  it('lit les données structurées publiées par le site', () => {
    const page = readJobPage(PAGE, 'https://careers.northwind.example/jobs/4471');
    expect(page.method).toBe('structured');
    expect(page.job).toMatchObject({ title: 'Senior Analyst, Transaction Services', company: 'Northwind Capital', location: 'Luxembourg, LU', country: 'LU', contractType: 'cdi', externalId: 'REQ-4471' });
    expect(page.job!.salary).toEqual({ min: 65000, max: 80000, currency: 'EUR', period: 'year' });
    expect(page.job!.descriptionHtml).toContain('Financial due diligence');
    expect(page.closed).toBe(false);
  });

  it('ne retient aucune offre sur une page de liste', () => {
    const list = `<html><head><script type="application/ld+json">[{"@type":"JobPosting","title":"A","hiringOrganization":"X"},{"@type":"JobPosting","title":"B","hiringOrganization":"X"}]</script></head><body><p>Liste</p></body></html>`;
    expect(findJobPostings(JSON.parse('[{"@type":"JobPosting","title":"A"},{"@type":["Thing","JobPosting"],"title":"B"}]'))).toHaveLength(2);
    expect(readJobPage(list, 'https://x.example/jobs').method).toBe('none');
  });

  it('signale une offre clôturée', () => {
    const closed = `<html><body><main><h1>Analyste</h1><p>Cette offre n'est plus disponible.</p></main></body></html>`;
    expect(readJobPage(closed, 'https://x.example/j/1').closed).toBe(true);
  });
});

describe('texte collé', () => {
  it('lit les libellés explicites et la première ligne', () => {
    expect(guessJobFields('Poste : Contrôleur de gestion\nEntreprise : Acme Industries\nLieu : Lyon\nType de contrat : CDI\n\nMissions…')).toEqual({ title: 'Contrôleur de gestion', company: 'Acme Industries', location: 'Lyon', contract: 'CDI' });
    expect(guessJobFields('Financial Analyst at Northwind Capital\n\nAbout the role…')).toMatchObject({ title: 'Financial Analyst', company: 'Northwind Capital' });
    expect(guessJobFields('Senior Analyst – Northwind (Luxembourg)\n\nAbout…')).toMatchObject({ title: 'Senior Analyst', company: 'Northwind', location: 'Luxembourg' });
  });
});

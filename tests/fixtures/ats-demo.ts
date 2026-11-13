// Formulaires de candidature de DÉMONSTRATION, servis localement par interception des
// requêtes dans le navigateur de test. Leur structure reprend celle des formulaires
// publics des ATS (champs, libellés, pièces jointes, étapes), mais aucun site réel
// n'est contacté et aucune candidature n'est envoyée à un recruteur.
import { createHash } from 'node:crypto';
import type { BrowserContext, Route } from 'playwright-core';

export interface DemoSubmission {
  url: string;
  fields: Record<string, string>;
  files: Record<string, { name: string; size: number; sha256: string }>;
}

export interface DemoStore {
  submissions: DemoSubmission[];
  /** Comportements de test : panne, refus de l'envoi, absence de confirmation… */
  mode: { failNext?: number; rejectEmail?: boolean; noConfirmation?: boolean; captcha?: boolean };
}

export const DEMO_URLS = {
  greenhouse: 'https://boards.greenhouse.io/demoadvisory/jobs/4100001',
  greenhouseCustom: 'https://boards.greenhouse.io/demoadvisory/jobs/4200001',
  lever: 'https://jobs.lever.co/demoadvisory/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
  workday: 'https://demoadvisory.wd3.myworkdayjobs.com/en-US/External/job/Paris/Senior-Associate_R0001',
  ashby: 'https://jobs.ashbyhq.com/demoadvisory/6f9619ff-8b86-d011-b42d-00cf4fc964ff',
  workable: 'https://apply.workable.com/demoadvisory/j/AB12CD34EF/',
  login: 'https://demoadvisory.taleo.net/careersection/2/jobapply.ftl?job=100',
  gone: 'https://boards.greenhouse.io/demoadvisory/jobs/4199999',
  down: 'https://jobs.ashbyhq.com/demoadvisory/00000000-0000-0000-0000-000000000000',
} as const;

const page = (title: string, body: string, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:sans-serif;max-width:760px;margin:24px auto}.field{margin:12px 0}label{display:block}.hidden{display:none}.error{color:#b00}</style></head><body>${body}<script>${script}</script></body></html>`;

const jobText = `<div id="content"><h1>Senior Associate – Transaction Services</h1><p>Financial due diligence for private equity funds. IFRS, quality of earnings, net debt, working capital.</p></div>`;

function greenhouseForm(custom: boolean, errors: Record<string, string> = {}) {
  const err = (k: string) => (errors[k] ? `<div class="error" role="alert" id="err-${k}">${errors[k]}</div>` : '');
  return page(
    'Job Application for Senior Associate at Demo Advisory',
    `${jobText}
<div id="application"><h2>Apply for this Job</h2>
<form id="application_form" action="submit" method="post" enctype="multipart/form-data">
  <div class="field"><label for="first_name">First Name <span class="asterisk">*</span></label><input type="text" id="first_name" name="job_application[first_name]" required></div>
  <div class="field"><label for="last_name">Last Name <span class="asterisk">*</span></label><input type="text" id="last_name" name="job_application[last_name]" required></div>
  <div class="field"><label for="email">Email <span class="asterisk">*</span></label><input type="text" id="email" name="job_application[email]" required ${errors.email ? 'aria-invalid="true" aria-describedby="err-email"' : ''}>${err('email')}</div>
  <div class="field"><label for="phone">Phone <span class="asterisk">*</span></label><input type="text" id="phone" name="job_application[phone]" required></div>
  <div class="field"><label>Resume/CV <span class="asterisk">*</span></label><button type="button" onclick="document.getElementById('resume').click()">Attach</button><input type="file" id="resume" name="job_application[resume]" class="hidden" accept=".pdf,.doc,.docx,.txt,.rtf" required></div>
  <div class="field"><label>Cover Letter</label><input type="file" id="cover_letter" name="job_application[cover_letter]" accept=".pdf,.doc,.docx"></div>
  <div class="field"><label for="q_linkedin">LinkedIn Profile</label><input type="text" id="q_linkedin" name="job_application[answers_attributes][0][text_value]"></div>
  <div class="field"><label for="q_auth">Are you legally authorized to work in France? <span class="asterisk">*</span></label><select id="q_auth" name="job_application[answers_attributes][1][boolean_value]" required><option value="">Please select</option><option value="1">Yes</option><option value="0">No</option></select></div>
  <div class="field"><label for="q_visa">Will you now or in the future require sponsorship for employment visa status? <span class="asterisk">*</span></label><select id="q_visa" name="job_application[answers_attributes][2][boolean_value]" required><option value="">Please select</option><option value="1">Yes</option><option value="0">No</option></select></div>
  <div class="field"><label for="q_source">How did you hear about this job?</label><select id="q_source" name="job_application[answers_attributes][3][text_value]"><option value="">Please select</option><option>LinkedIn</option><option>Company website</option><option>Referral</option><option>Other</option></select></div>
  ${custom ? `<div class="field"><label for="q_cfa">Have you passed CFA Level I? <span class="asterisk">*</span></label><select id="q_cfa" name="job_application[answers_attributes][4][boolean_value]" required><option value="">Please select</option><option value="1">Yes</option><option value="0">No</option></select></div>` : ''}
  <fieldset><legend>U.S. Equal Employment Opportunity information (voluntary)</legend>
    <div class="field"><label for="gender">Gender</label><select id="gender" name="job_application[gender]"><option value="">Please select</option><option value="1">Male</option><option value="2">Female</option><option value="3">Decline To Self Identify</option></select></div>
  </fieldset>
  <div class="field"><input type="checkbox" id="gdpr" name="job_application[data_compliance][gdpr_consent_given]" value="1" required><label for="gdpr">I have read and accept the privacy policy of Demo Advisory *</label></div>
  <input type="submit" id="submit_app" value="Submit Application">
</form></div>`,
  );
}

const leverForm = (captcha: boolean) =>
  page(
    'Demo Advisory - Senior Associate',
    `<div class="posting-headline"><h2>Senior Associate</h2></div>
<form id="application-form" method="POST" enctype="multipart/form-data">
<h4>Submit your application</h4>
<ul>
 <li class="application-question resume"><div class="application-label">Resume/CV<span class="required">✱</span></div><div class="application-field"><input type="file" name="resume" id="resume-upload-input" required></div></li>
 <li class="application-question"><div class="application-label">Full name<span class="required">✱</span></div><div class="application-field"><input type="text" name="name" required></div></li>
 <li class="application-question"><div class="application-label">Email<span class="required">✱</span></div><div class="application-field"><input type="email" name="email" required></div></li>
 <li class="application-question"><div class="application-label">Phone</div><div class="application-field"><input type="text" name="phone"></div></li>
 <li class="application-question"><div class="application-label">Current company</div><div class="application-field"><input type="text" name="org"></div></li>
 <li class="application-question"><div class="application-label">LinkedIn URL</div><div class="application-field"><input type="text" name="urls[LinkedIn]"></div></li>
 <li class="application-question custom-question"><div class="application-label">Are you authorized to work in Luxembourg?<span class="required">✱</span></div>
   <div class="application-field"><ul><li><label><input type="radio" name="cards[q1][field0]" value="Yes" required> Yes</label></li><li><label><input type="radio" name="cards[q1][field0]" value="No"> No</label></li></ul></div></li>
 <li class="application-question"><div class="application-label">Additional information</div><div class="application-field"><textarea name="comments"></textarea></div></li>
</ul>
${captcha ? '<div class="h-captcha" data-sitekey="10000000-ffff-ffff-ffff-000000000001"><iframe title="Widget containing checkbox for hCaptcha security challenge" src="about:blank" width="303" height="78"></iframe></div>' : ''}
<button type="submit" class="template-btn-submit">Submit application</button>
</form>`,
  );

// Workday : parcours en plusieurs étapes sur la même adresse, validation des champs obligatoires à chaque étape.
const workdayApply = page(
  'Senior Associate - Apply',
  `<div id="wd">
<section data-step="1"><h2>My Information</h2>
  <div data-automation-id="formField-legalNameSection_firstName"><label for="fn">Given Name(s)*</label><input id="fn" data-automation-id="legalNameSection_firstName" required></div>
  <div data-automation-id="formField-legalNameSection_lastName"><label for="ln">Family Name*</label><input id="ln" data-automation-id="legalNameSection_lastName" required></div>
  <div><label for="em">Email Address*</label><input id="em" type="email" required></div>
  <div><label for="ph">Phone Number*</label><input id="ph" type="tel" required></div>
  <div><label for="ctry">Country*</label><select id="ctry" required><option value="">Select One</option><option value="FR">France</option><option value="LU">Luxembourg</option><option value="GB">United Kingdom</option></select></div>
</section>
<section data-step="2" class="hidden"><h2>My Experience</h2>
  <div><label for="cv">Resume/CV*</label><input id="cv" type="file" accept=".pdf,.docx" required></div>
</section>
<section data-step="3" class="hidden"><h2>Application Questions</h2>
  <fieldset><legend>Are you legally authorized to work in the country in which this job is located?*</legend><label><input type="radio" name="auth" value="yes" required> Yes</label><label><input type="radio" name="auth" value="no"> No</label></fieldset>
  <fieldset><legend>Will you now or in the future require visa sponsorship?*</legend><label><input type="radio" name="visa" value="yes" required> Yes</label><label><input type="radio" name="visa" value="no"> No</label></fieldset>
  <div><label for="notice">What is your notice period?*</label><input id="notice" required></div>
</section>
<section data-step="4" class="hidden"><h2>Review</h2><p>Please review your application.</p></section>
<div id="msg" role="alert" class="error"></div>
<div id="nav"><button type="button" id="next" data-automation-id="bottom-navigation-next-button">Save and Continue</button><button type="button" id="submit" class="hidden" data-automation-id="bottom-navigation-submit-button">Submit</button></div>
<div id="done" class="hidden"><h2>Application Submitted</h2><p>Thank you for applying! Your application was successfully submitted.</p></div>
</div>`,
  `let step = 1;
const show = () => { document.querySelectorAll('section').forEach(s => s.classList.toggle('hidden', Number(s.dataset.step) !== step)); document.getElementById('next').classList.toggle('hidden', step === 4); document.getElementById('submit').classList.toggle('hidden', step !== 4); };
const invalid = () => Array.from(document.querySelectorAll('section[data-step="' + step + '"] [required]')).filter(el => el.type === 'radio' ? !document.querySelector('input[name="' + el.name + '"]:checked') : el.type === 'file' ? !el.files.length : !el.value);
document.getElementById('next').onclick = () => { const bad = invalid(); bad.forEach(el => el.setAttribute('aria-invalid', 'true')); document.getElementById('msg').textContent = bad.length ? 'Errors found: ' + bad.length + ' required field(s) missing.' : ''; if (!bad.length) { step++; show(); } };
document.getElementById('submit').onclick = async () => { const data = new FormData(); document.querySelectorAll('input,select').forEach(el => { if (el.type === 'file') { if (el.files[0]) data.append(el.id, el.files[0]); } else if (el.type === 'radio') { if (el.checked) data.append(el.name, el.value); } else data.append(el.id, el.value); }); const r = await fetch(location.href.replace(/\\/apply$/, '/submit'), { method: 'POST', body: data }); if (r.ok) { document.querySelectorAll('section,#nav').forEach(s => s.classList.add('hidden')); document.getElementById('done').classList.remove('hidden'); } };
show();`,
);

const workdayJob = page('Senior Associate', `${jobText}<a href="${DEMO_URLS.workday}/apply" role="button">Apply</a>`);

// Ashby : liste déroulante personnalisée (combobox) et champs système.
const ashbyForm = page(
  'Demo Advisory – Application',
  `<form id="app" action="/submit" method="post" enctype="multipart/form-data">
  <div class="field"><label for="_systemfield_name">Name*</label><input id="_systemfield_name" name="_systemfield_name" required></div>
  <div class="field"><label for="_systemfield_email">Email*</label><input id="_systemfield_email" name="_systemfield_email" type="email" required></div>
  <div class="field"><label for="_systemfield_resume">Resume*</label><input id="_systemfield_resume" name="_systemfield_resume" type="file" required></div>
  <div class="field"><label id="loc-label">Where are you currently based?*</label>
    <input role="combobox" id="loc" aria-labelledby="loc-label" aria-controls="loc-list" aria-expanded="false" autocomplete="off" required>
    <input type="hidden" name="location" id="loc-value">
    <ul role="listbox" id="loc-list" class="hidden"><li role="option">Paris, France</li><li role="option">Luxembourg</li><li role="option">London, United Kingdom</li></ul></div>
  <button type="submit">Submit Application</button>
</form>`,
  `const input = document.getElementById('loc'); const list = document.getElementById('loc-list');
input.addEventListener('focus', () => { list.classList.remove('hidden'); input.setAttribute('aria-expanded', 'true'); });
input.addEventListener('click', () => { list.classList.remove('hidden'); });
input.addEventListener('input', () => { list.classList.remove('hidden'); Array.from(list.children).forEach(li => li.classList.toggle('hidden', !li.textContent.toLowerCase().includes(input.value.toLowerCase()))); });
list.addEventListener('click', (e) => { const li = e.target.closest('[role=option]'); if (!li) return; input.value = li.textContent; document.getElementById('loc-value').value = li.textContent; list.classList.add('hidden'); });`,
);

const workableForm = page(
  'Demo Advisory – Apply',
  `<form method="post" enctype="multipart/form-data" action="submit">
  <div class="field"><label for="firstname">First name *</label><input id="firstname" name="firstname" required></div>
  <div class="field"><label for="lastname">Last name *</label><input id="lastname" name="lastname" required></div>
  <div class="field"><label for="em">Email *</label><input id="em" name="email" type="email" required></div>
  <div class="field"><label for="res">Resume *</label><input id="res" name="resume" type="file" required></div>
  <button type="submit">Submit application</button>
</form>`,
);

const loginPage = page('Sign In', `<form><div class="field"><label for="u">Email Address</label><input id="u" type="email"></div><div class="field"><label for="p">Password</label><input id="p" type="password"></div><button type="submit">Sign In</button></form>`);

async function parseMultipart(route: Route): Promise<{ fields: Record<string, string>; files: DemoSubmission['files'] }> {
  const req = route.request();
  const buf = req.postDataBuffer() ?? Buffer.alloc(0);
  const form = await new Response(buf, { headers: { 'content-type': (await req.allHeaders())['content-type'] ?? '' } }).formData();
  const fields: Record<string, string> = {};
  const files: DemoSubmission['files'] = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === 'string') fields[k] = v;
    else if (v.size) {
      const data = Buffer.from(await v.arrayBuffer());
      files[k] = { name: v.name, size: v.size, sha256: createHash('sha256').update(data).digest('hex') };
    }
  }
  return { fields, files };
}

const html = (route: Route, body: string, status = 200) => route.fulfill({ status, contentType: 'text/html; charset=utf-8', body });

export async function installDemoAts(context: BrowserContext, store: DemoStore): Promise<void> {
  await context.route(/^https:\/\/(boards\.greenhouse\.io|jobs\.lever\.co|[a-z]+\.wd3\.myworkdayjobs\.com|jobs\.ashbyhq\.com|apply\.workable\.com|[a-z]+\.taleo\.net)\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const full = `${url.origin}${url.pathname}`;
    if (store.mode.failNext && store.mode.failNext > 0) {
      store.mode.failNext--;
      return html(route, page('Service Unavailable', '<h1>503</h1>'), 503);
    }
    if (full === DEMO_URLS.down) return html(route, page('Error', '<h1>Service Unavailable</h1>'), 503);
    if (full === DEMO_URLS.gone) return html(route, page('Not found', '<h1>The job you are looking for is no longer open.</h1>'), 404);
    if (url.host === 'boards.greenhouse.io') {
      const custom = /\/jobs\/42\d+/.test(url.pathname);
      if (req.method() === 'POST') {
        const sub = await parseMultipart(route);
        if (store.mode.rejectEmail) return html(route, greenhouseForm(custom, { email: 'Email is invalid' }));
        store.submissions.push({ url: full, ...sub });
        if (store.mode.noConfirmation) return html(route, page('Demo Advisory', '<p>Loading…</p>'));
        return html(route, page('Thank you', '<div id="application_confirmation"><h1>Thank you for applying.</h1><p>Your application has been received. We will review it shortly.</p></div>'));
      }
      return html(route, greenhouseForm(custom));
    }
    if (url.host === 'jobs.lever.co') {
      if (req.method() === 'POST') {
        const sub = await parseMultipart(route);
        store.submissions.push({ url: full, ...sub });
        return html(route, page('Application submitted', '<h3>Application submitted!</h3><p>Thanks for applying to Demo Advisory.</p>'));
      }
      if (url.pathname.endsWith('/apply')) return html(route, leverForm(Boolean(store.mode.captcha)));
      return html(route, page('Senior Associate', `${jobText}<a class="postings-btn" href="${full}/apply">Apply for this job</a>`));
    }
    if (url.host.endsWith('myworkdayjobs.com')) {
      if (req.method() === 'POST') {
        const sub = await parseMultipart(route);
        store.submissions.push({ url: full, ...sub });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      }
      return html(route, url.pathname.endsWith('/apply') ? workdayApply : workdayJob);
    }
    if (url.host === 'jobs.ashbyhq.com') {
      if (req.method() === 'POST') {
        const sub = await parseMultipart(route);
        store.submissions.push({ url: full, ...sub });
        return html(route, page('Application submitted', '<h2>Thanks for applying!</h2><p>Your application was successfully submitted.</p>'));
      }
      return html(route, ashbyForm);
    }
    if (url.host === 'apply.workable.com') {
      if (req.method() === 'POST') {
        const sub = await parseMultipart(route);
        store.submissions.push({ url: full, ...sub });
        return html(route, page('Demo Advisory', '<p>Processing…</p>'));
      }
      return html(route, workableForm);
    }
    if (url.host.endsWith('taleo.net')) return html(route, loginPage);
    return route.abort();
  });
}

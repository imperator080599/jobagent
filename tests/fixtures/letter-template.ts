// Modèle de lettre fictif pour les tests : zones entre crochets, consignes en
// italique sous chaque rubrique, pied de page publicitaire du fournisseur du modèle.
import { AlignmentType, Document, Footer, Packer, Paragraph, TextRun } from 'docx';

export async function letterTemplateDocx(): Promise<Uint8Array> {
  const p = (text: string, o: { right?: boolean; italics?: boolean; bold?: boolean } = {}) =>
    new Paragraph({ alignment: o.right ? AlignmentType.RIGHT : AlignmentType.LEFT, children: text ? [new TextRun({ text, font: 'Arial', size: 22, italics: o.italics, bold: o.bold })] : [] });
  const doc = new Document({
    sections: [
      {
        footers: { default: new Footer({ children: [new Paragraph({ children: [new TextRun('Modèle fourni par ExempleModeles.com — Copyright Exemple Ltd.')] })] }) },
        children: [
          p('[Your name]', { right: true, bold: true }),
          p('[Your phone number]', { right: true }),
          p('[email address]', { right: true }),
          p('[name of the recruiter]'),
          p('[name of the office]'),
          p(''),
          p('[date]', { right: true }),
          p(''),
          p('Dear Mr/Ms [name of the recruiter],'),
          p(''),
          p('[Introduction]'),
          p(''),
          p('State the purpose of your letter and the position you are applying for.', { italics: true }),
          p(''),
          p('[Why me?]'),
          p(''),
          p('State the top attributes that you bring to the role.', { italics: true }),
          p(''),
          p('[Why this job?]'),
          p(''),
          p('Explain why this role and this firm.', { italics: true }),
          p(''),
          p('[Wrap up]'),
          p(''),
          p('End with a closing statement.', { italics: true }),
          p(''),
          p('Yours sincerely,'),
          p(''),
          p('[Signature]'),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

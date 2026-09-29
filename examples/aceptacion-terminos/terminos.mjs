// Arma el PDF de aceptación de términos con los datos y la firma de conformidad
// que cargó el usuario. El texto de los términos lo pone el servidor: el
// navegador sólo aporta nombre, DNI y el trazo de la firma.
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export const TITULO = "Aceptación de Términos y Condiciones";

const CLAUSULAS = [
  [
    "1. Objeto",
    "El presente documento regula el uso de los servicios ofrecidos por la Empresa. Al firmarlo, la persona firmante declara haber leído, comprendido y aceptado la totalidad de estos términos.",
  ],
  [
    "2. Datos personales",
    "La persona firmante presta su consentimiento para el tratamiento de los datos personales aquí consignados con la única finalidad de identificarla y dejar constancia de esta aceptación, conforme a la normativa de protección de datos personales vigente.",
  ],
  [
    "3. Obligaciones",
    "La persona firmante se compromete a hacer un uso adecuado de los servicios, a no utilizarlos con fines ilícitos y a mantener actualizada la información que proporcione.",
  ],
  [
    "4. Modificaciones",
    "La Empresa podrá modificar estos términos notificándolo con al menos treinta (30) días de anticipación. El uso continuado de los servicios luego de ese plazo implica la aceptación de los cambios.",
  ],
  [
    "5. Jurisdicción",
    "Para cualquier controversia derivada del presente, las partes se someten a la jurisdicción de los tribunales ordinarios competentes, renunciando a cualquier otro fuero.",
  ],
];

const A4 = [595.28, 841.89];
const MARGEN = 56;
const TINTA = rgb(0.12, 0.13, 0.16);
const GRIS = rgb(0.42, 0.45, 0.5);

/**
 * @param {{ nombre: string, dni: string, firmaPng: Uint8Array, fecha: Date }} d
 * @returns {Promise<Uint8Array>}
 */
export async function generarPdf({ nombre, dni, firmaPng, fecha }) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(TITULO);
  pdf.setAuthor(nombre);
  pdf.setCreationDate(fecha);
  pdf.setModificationDate(fecha);

  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold);
  const firma = await pdf.embedPng(firmaPng);

  const pagina = pdf.addPage(A4);
  const ancho = A4[0] - MARGEN * 2;
  let y = A4[1] - MARGEN;

  const escribir = (texto, { fuente = normal, tam = 10.5, color = TINTA, interlineado = 1.45 } = {}) => {
    for (const linea of partirEnLineas(texto, fuente, tam, ancho)) {
      y -= tam * interlineado;
      pagina.drawText(linea, { x: MARGEN, y, size: tam, font: fuente, color });
    }
  };

  escribir(TITULO, { fuente: negrita, tam: 18 });
  y -= 6;
  escribir(`Fecha: ${fecha.toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" })}`, { color: GRIS, tam: 9.5 });
  y -= 14;

  escribir(
    `Quien suscribe, ${nombre}, DNI ${dni}, manifiesta su conformidad con los términos y condiciones que se detallan a continuación.`,
  );
  y -= 8;

  for (const [titulo, cuerpo] of CLAUSULAS) {
    y -= 6;
    escribir(titulo, { fuente: negrita, tam: 11 });
    escribir(cuerpo);
  }

  // Bloque de firma de conformidad, al pie.
  const altoFirma = 70;
  const anchoFirma = Math.min(220, (firma.width / firma.height) * altoFirma);
  const baseFirma = MARGEN + 70;
  pagina.drawImage(firma, { x: MARGEN, y: baseFirma + 6, width: anchoFirma, height: altoFirma });
  pagina.drawLine({ start: { x: MARGEN, y: baseFirma }, end: { x: MARGEN + 240, y: baseFirma }, thickness: 0.8, color: GRIS });
  const pie = [
    ["Firma de conformidad", negrita],
    [`Aclaración: ${nombre}`, normal],
    [`DNI: ${dni}`, normal],
  ];
  pie.forEach(([texto, fuente], i) => {
    pagina.drawText(texto, { x: MARGEN, y: baseFirma - 14 - i * 14, size: 9.5, font: fuente, color: TINTA });
  });

  return pdf.save();
}

function partirEnLineas(texto, fuente, tam, ancho) {
  const lineas = [];
  let actual = "";
  for (const palabra of texto.split(/\s+/)) {
    const prueba = actual ? `${actual} ${palabra}` : palabra;
    if (actual && fuente.widthOfTextAtSize(prueba, tam) > ancho) {
      lineas.push(actual);
      actual = palabra;
    } else {
      actual = prueba;
    }
  }
  if (actual) lineas.push(actual);
  return lineas;
}

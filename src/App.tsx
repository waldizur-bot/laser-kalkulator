import React, { useEffect, useMemo, useRef, useState } from "react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

/**
 * Prototyp webowej aplikacji do:
 * - wgrywania plikow SVG (np. eksport z LightBurn)
 * - skalowania i ustawiania ilosci projektow
 * - prostego nestingu (heurystyka: shelf/row packing) na arkuszu
 * - wyliczania kosztow (material + energia + amortyzacja + robocizna)
 * - dodawania: dostawa (A/B/C/brak), opakowanie, prowizja Allegro (%), podatek 8.5%, VAT (wg wzoru)
 * - eksportu ulozenia do SVG (do ponownego otwarcia w LightBurn)
 * - eksportu PDF dla klienta z wycena
 */

/* =========================
   USTAWIENIA (stałe)
   ========================= */
const TAX_RATE = 0.085; // 8.5%
const VAT_RATE = 0.23;  // 23%

// VAT "z kwoty brutto" (jeśli traktujesz kwoty jako brutto)
function vatFromGross(gross: number) {
  // brutto = netto * 1.23 => VAT = brutto - brutto/1.23 = brutto * 23/123
  return gross * (VAT_RATE / (1 + VAT_RATE));
}

/* =========================
   Helpers
   ========================= */
function mmToPx(mm: number, scale: number) {
  return mm * scale;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function parseSvgSize(svgText: string): { w: number; h: number } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  const svg = doc.querySelector("svg");
  if (!svg) return { w: 100, h: 100 };

  const vb = svg.getAttribute("viewBox");
  if (vb) {
    const parts = vb
      .split(/[ ,]+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => Number(x));
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      return { w: Math.max(1, parts[2]), h: Math.max(1, parts[3]) };
    }
  }

  const wAttr = svg.getAttribute("width");
  const hAttr = svg.getAttribute("height");
  const w = wAttr ? parseFloat(wAttr) : NaN;
  const h = hAttr ? parseFloat(hAttr) : NaN;
  if (Number.isFinite(w) && Number.isFinite(h)) return { w: Math.max(1, w), h: Math.max(1, h) };

  return { w: 100, h: 100 };
}

function makeId() {
  return Math.random().toString(36).slice(2, 9);
}

function shelfPack(
  items: { id: string; w: number; h: number; pad: number }[],
  binW: number,
  binH: number
): { ok: boolean; placed: Record<string, { x: number; y: number }> } {
  const placed: Record<string, { x: number; y: number }> = {};
  const sorted = [...items].sort((a, b) => b.h - a.h);

  let cursorX = 0;
  let cursorY = 0;
  let rowH = 0;

  for (const it of sorted) {
    const W = it.w + it.pad * 2;
    const H = it.h + it.pad * 2;

    if (W > binW || H > binH) return { ok: false, placed: {} };

    if (cursorX + W > binW) {
      cursorX = 0;
      cursorY += rowH;
      rowH = 0;
    }

    if (cursorY + H > binH) return { ok: false, placed: {} };

    placed[it.id] = { x: cursorX + it.pad, y: cursorY + it.pad };
    cursorX += W;
    rowH = Math.max(rowH, H);
  }

  return { ok: true, placed };
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function fmtPLN(n: number) {
  const safe = Number.isFinite(n) ? n : 0;
  return `${safe.toFixed(2)} PLN`;
}

function nowStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return {
    date: `${yyyy}-${mm}-${dd}`,
    time: `${hh}:${mi}`,
    id: `WYC-${yyyy}${mm}${dd}-${hh}${mi}`,
  };
}

/* =========================
   Types
   ========================= */
type Design = {
  id: string;
  name: string;
  svgText: string;
  baseW: number;
  baseH: number;
  scale: number;
  qty: number;
  minutesOverride?: number;
};

type Placed = {
  instanceId: string;
  designId: string;
  name: string;
  w: number;
  h: number;
  x: number;
  y: number;
};

type MaterialProfile = {
  id: string;
  name: string;
  sheetCost: number; // PLN / arkusz
};

const MATERIALS_DEFAULT: MaterialProfile[] = [
  { id: "plywood_3", name: "Sklejka 3 mm", sheetCost: 20 },
  { id: "hdf_3", name: "HDF 3 mm", sheetCost: 10 },
];

type ShippingSize = "none" | "A" | "B" | "C";

/* =========================
   App
   ========================= */
export default function App() {
  // Arkusz
  const [sheetW, setSheetW] = useState(762); // mm
  const [sheetH, setSheetH] = useState(762); // mm
  const [kerf, setKerf] = useState(0.15); // mm (info)
  const [padding, setPadding] = useState(1); // mm

  // Materialy
  const [materials, setMaterials] = useState<MaterialProfile[]>(MATERIALS_DEFAULT);
  const [materialId, setMaterialId] = useState<string>(MATERIALS_DEFAULT[0].id);
  const selectedMaterial = useMemo(() => materials.find((m) => m.id === materialId) ?? materials[0], [materials, materialId]);
  const sheetCost = selectedMaterial.sheetCost;

  const setSheetCostForSelected = (v: number) => {
    setMaterials((prev) => prev.map((m) => (m.id === materialId ? { ...m, sheetCost: Math.max(0, v) } : m)));
  };

  // Koszty czasu/energii
  const [powerPrice, setPowerPrice] = useState(1.1); // PLN / kWh
  const [deprPerHour, setDeprPerHour] = useState(1.2); // PLN / h
  const [laborPerHour, setLaborPerHour] = useState(31); // PLN / h

  // Cena (Twoja marża) – nakładana na KOSZT PRODUKCJI + (dostawa+opakowanie), bez Allegro/podatków (żeby nie robić pętli)
  const [marginPercent, setMarginPercent] = useState(250); // %
  const [minOrderPrice, setMinOrderPrice] = useState(10); // PLN

  // Maszyna (uproczony model czasu/energii)
  const [laserWatt, setLaserWatt] = useState(200); // W
  const [assistWatt, setAssistWatt] = useState(1000); // W
  const [baseMinutesPerItem, setBaseMinutesPerItem] = useState(3); // min / szt
  const [setupMinutes, setSetupMinutes] = useState(6); // min / zamowienie

  // Nowe: dostawa / opakowanie / Allegro
  const [shippingSize, setShippingSize] = useState<ShippingSize>("none");
  const [shippingCostA, setShippingCostA] = useState(15);
  const [shippingCostB, setShippingCostB] = useState(18);
  const [shippingCostC, setShippingCostC] = useState(25);

  const [packagingCost, setPackagingCost] = useState(0); // PLN
  const [allegroFeePercent, setAllegroFeePercent] = useState(0); // %

  // Projekty
  const [designs, setDesigns] = useState<Design[]>([]);

  // Skala podgladu
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [viewScale, setViewScale] = useState(1.0);

  /* =========================
     Instances + Nesting
     ========================= */
  const instances = useMemo(() => {
    const out: { instanceId: string; designId: string; name: string; w: number; h: number }[] = [];
    for (const d of designs) {
      const w = d.baseW * d.scale;
      const h = d.baseH * d.scale;
      for (let i = 0; i < d.qty; i++) out.push({ instanceId: `${d.id}__${i + 1}`, designId: d.id, name: d.name, w, h });
    }
    return out;
  }, [designs]);

  const nesting = useMemo(() => {
    const items = instances.map((it) => ({ id: it.instanceId, w: it.w, h: it.h, pad: padding }));
    const packed = shelfPack(items, sheetW, sheetH);
    if (!packed.ok) return { ok: false as const, placed: [] as Placed[] };

    const placed: Placed[] = instances.map((it) => {
      const p = packed.placed[it.instanceId];
      return { ...it, x: p.x, y: p.y };
    });

    return { ok: true as const, placed };
  }, [instances, padding, sheetW, sheetH]);

  /* =========================
     Draw
     ========================= */
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;

    const maxW = 1000;
    const maxH = 520;
    const s = Math.min(maxW / sheetW, maxH / sheetH) * viewScale;

    c.width = Math.floor(sheetW * s);
    c.height = Math.floor(sheetH * s);

    ctx.clearRect(0, 0, c.width, c.height);

    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, c.width - 2, c.height - 2);

    ctx.globalAlpha = 0.25;
    ctx.lineWidth = 1;
    for (let x = 50; x < sheetW; x += 50) {
      ctx.beginPath();
      ctx.moveTo(mmToPx(x, s), 0);
      ctx.lineTo(mmToPx(x, s), c.height);
      ctx.stroke();
    }
    for (let y = 50; y < sheetH; y += 50) {
      ctx.beginPath();
      ctx.moveTo(0, mmToPx(y, s));
      ctx.lineTo(c.width, mmToPx(y, s));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    if (!nesting.ok) {
      ctx.font = "16px sans-serif";
      ctx.fillText("Nie miesci sie na arkuszu — zmniejsz skale/ilosc albo zwieksz arkusz.", 10, 24);
      return;
    }

    ctx.lineWidth = 2;
    ctx.font = "12px sans-serif";
    nesting.placed.forEach((p) => {
      const x = mmToPx(p.x, s);
      const y = mmToPx(p.y, s);
      const w = mmToPx(p.w, s);
      const h = mmToPx(p.h, s);
      ctx.strokeRect(x, y, w, h);
      ctx.fillText(p.instanceId, x + 4, y + 14);
    });
  }, [nesting, sheetW, sheetH, viewScale]);

  /* =========================
     Koszty bazowe
     ========================= */
  const totalArea = useMemo(() => instances.reduce((acc, it) => acc + it.w * it.h, 0), [instances]); // mm2
  const sheetArea = sheetW * sheetH; // mm2

  // Liczba arkuszy – NIE zaniżamy (to była logiczna mina w clamp do 1)
  const sheetsNeeded = useMemo(() => {
    if (instances.length === 0) return 0;
    const ratio = totalArea / Math.max(1e-9, sheetArea);
    return Math.max(1, Math.ceil(ratio));
  }, [instances.length, totalArea, sheetArea]);

  // Koszt materiału dla zamówienia: arkuszeNeeded * sheetCost
  const materialCostOrder = useMemo(() => {
    if (sheetsNeeded === 0) return 0;
    return sheetCost * sheetsNeeded;
  }, [sheetCost, sheetsNeeded]);

  // Materiał rozbijamy per instancja proporcjonalnie do pola, ale tak żeby suma = materialCostOrder
  const materialCostPerMm2Effective = useMemo(() => {
    if (instances.length === 0) return 0;
    // rozbijamy koszt zamówienia po realnie użytej powierzchni bbox (spójnie)
    return materialCostOrder / Math.max(1e-9, totalArea);
  }, [instances.length, materialCostOrder, totalArea]);

  const timeAndEnergyTotals = useMemo(() => {
    let minutes = setupMinutes;
    for (const it of instances) {
      const d = designs.find((x) => x.id === it.designId);
      const m = d?.minutesOverride ?? baseMinutesPerItem;
      minutes += m;
    }
    const hours = minutes / 60;
    const kwh = ((laserWatt + assistWatt) / 1000) * hours;
    return { minutes, hours, kwh };
  }, [instances, designs, baseMinutesPerItem, setupMinutes, laserWatt, assistWatt]);

  const orderCostsTime = useMemo(() => {
    const energy = timeAndEnergyTotals.kwh * powerPrice;
    const depr = timeAndEnergyTotals.hours * deprPerHour;
    const labor = timeAndEnergyTotals.hours * laborPerHour;
    return { energy, depr, labor, total: energy + depr + labor };
  }, [timeAndEnergyTotals, powerPrice, deprPerHour, laborPerHour]);

  // Koszt produkcji = czas+energia+robocizna+amortyzacja + materiał
  const productionCost = useMemo(() => {
    return orderCostsTime.total + materialCostOrder;
  }, [orderCostsTime.total, materialCostOrder]);

  /* =========================
     Dostawa / opakowanie
     ========================= */
  const shippingCost = useMemo(() => {
    if (shippingSize === "A") return Math.max(0, shippingCostA);
    if (shippingSize === "B") return Math.max(0, shippingCostB);
    if (shippingSize === "C") return Math.max(0, shippingCostC);
    return 0;
  }, [shippingSize, shippingCostA, shippingCostB, shippingCostC]);

  const packaging = useMemo(() => Math.max(0, packagingCost), [packagingCost]);

  /* =========================
     Cena sprzedaży (bez pętli)
     - marża liczona od (productionCost + shipping + packaging)
     - NIE doliczamy Allegro/podatków do podstawy, bo to tworzy pętle i "magiczne" zachowania
     ========================= */
  const sellPriceGross = useMemo(() => {
    const base = productionCost + shippingCost + packaging;
    const withMargin = base * (1 + Math.max(0, marginPercent) / 100);
    return Math.max(withMargin, Math.max(0, minOrderPrice));
  }, [productionCost, shippingCost, packaging, marginPercent, minOrderPrice]);

  /* =========================
     Allegro / podatek 8.5 / VAT (wg Twojego wzoru)
     ========================= */

  // Allegro to KOSZT. Liczymy od ceny sprzedaży (brutto), bo tak chcesz,
  // ale bez sprzężenia, bo sellPriceGross nie zależy od allegroFee.
  const allegroFee = useMemo(() => {
    const p = Math.max(0, allegroFeePercent) / 100;
    return sellPriceGross * p;
  }, [sellPriceGross, allegroFeePercent]);

  const tax85 = useMemo(() => sellPriceGross * TAX_RATE, [sellPriceGross]);

  // VAT wg Twojego wzoru:
  // VAT(sprzedaż) - VAT(allegro) - VAT(materiał) - VAT(opakowanie)
  // (Założenie: kwoty wpisujesz jako brutto z 23% tam gdzie ma to sens.)
  const vatCalc = useMemo(() => {
    const vatSale = vatFromGross(sellPriceGross);
    const vatAllegro = vatFromGross(allegroFee);
    const vatMaterial = vatFromGross(materialCostOrder);
    const vatPackaging = vatFromGross(packaging);
    return vatSale - vatAllegro - vatMaterial - vatPackaging;
  }, [sellPriceGross, allegroFee, materialCostOrder, packaging]);

  // ZYSK wg Twojego opisu:
  // cena koncowa z transportem - cena materialu - cena opak - podatek 8.5% - VAT(wg wzoru) - prad i robocizna - allegro
  // (shipping jest już w sellPriceGross i odejmujemy go jako realny koszt wysyłki)
  const profit = useMemo(() => {
    const revenue = sellPriceGross;
    const costs =
      materialCostOrder +
      packaging +
      shippingCost +
      tax85 +
      vatCalc +
      orderCostsTime.total +
      allegroFee;

    return revenue - costs;
  }, [sellPriceGross, materialCostOrder, packaging, shippingCost, tax85, vatCalc, orderCostsTime.total, allegroFee]);

  /* =========================
     Per-item i tabela per projekt (spójna z materiałem)
     ========================= */
  const perItemCostBase = useMemo(() => {
    // koszt bazowy instancji = materiał (spójny z materialCostOrder) + udział kosztów czasu
    if (instances.length === 0) return new Map<string, number>();

    const minutesByInstance = new Map<string, number>();
    let sumM = 0;
    for (const it of instances) {
      const d = designs.find((x) => x.id === it.designId);
      const m = d?.minutesOverride ?? baseMinutesPerItem;
      minutesByInstance.set(it.instanceId, m);
      sumM += m;
    }

    const out = new Map<string, number>();
    for (const it of instances) {
      const mat = (it.w * it.h) * materialCostPerMm2Effective;
      const m = minutesByInstance.get(it.instanceId) ?? baseMinutesPerItem;
      const timePart = sumM > 0 ? (m / sumM) * orderCostsTime.total : orderCostsTime.total / instances.length;
      out.set(it.instanceId, mat + timePart);
    }

    return out;
  }, [instances, designs, baseMinutesPerItem, materialCostPerMm2Effective, orderCostsTime.total]);

  const groupedCostsBase = useMemo(() => {
    const byDesign = new Map<string, { name: string; count: number; sum: number }>();
    for (const it of instances) {
      const cost = perItemCostBase.get(it.instanceId) ?? 0;
      const cur = byDesign.get(it.designId) ?? { name: it.name, count: 0, sum: 0 };
      cur.count += 1;
      cur.sum += cost;
      byDesign.set(it.designId, cur);
    }
    return Array.from(byDesign.entries()).map(([designId, v]) => ({
      designId,
      name: v.name,
      qty: v.count,
      unitCost: v.count ? v.sum / v.count : 0,
      totalCost: v.sum,
    }));
  }, [instances, perItemCostBase]);

  /* =========================
     Import / Export
     ========================= */
  async function onAddSvg(files: FileList | null) {
    if (!files || files.length === 0) return;

    const next: Design[] = [];
    for (const f of Array.from(files)) {
      const text = await f.text();
      const { w, h } = parseSvgSize(text);
      next.push({
        id: makeId(),
        name: f.name.replace(/\.[^.]+$/, ""),
        svgText: text,
        baseW: w,
        baseH: h,
        scale: 1,
        qty: 1,
      });
    }
    setDesigns((prev) => [...prev, ...next]);
  }

  function removeDesign(id: string) {
    setDesigns((prev) => prev.filter((d) => d.id !== id));
  }

  function updateDesign(id: string, patch: Partial<Design>) {
    setDesigns((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }

  function exportLayoutSvg() {
    if (!nesting.ok) return;

    const header = `<?xml version="1.0" encoding="UTF-8"?>\n`;
    const svgOpen = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}mm" height="${sheetH}mm" viewBox="0 0 ${sheetW} ${sheetH}">\n`;
    const svgClose = `</svg>\n`;

    const body: string[] = [];
    body.push(`<rect x="0" y="0" width="${sheetW}" height="${sheetH}" fill="none" stroke="black" stroke-width="0.2"/>`);

    for (const p of nesting.placed) {
      const d = designs.find((x) => x.id === p.designId);
      if (!d) continue;

      const inner = d.svgText
        .replace(/^[\s\S]*?<svg[^>]*>/i, "")
        .replace(/<\/svg>[\s\S]*$/i, "");

      body.push(`<g transform="translate(${p.x} ${p.y}) scale(${d.scale})">${inner}</g>`);
    }

    const out = header + svgOpen + body.join("\n") + "\n" + svgClose;
    downloadText("layout_export.svg", out);
  }

  function exportPdfClient() {
    const { id, date, time } = nowStamp();

    // W PDF: projekty skalujemy tak, żeby suma projektów = "sellPriceGross - shipping - packaging"
    // (a dostawa/opakowanie pokazane osobno jako pozycje).
    const productsTarget = Math.max(0, sellPriceGross - shippingCost - packaging);

    const baseSumCosts = groupedCostsBase.reduce((acc, r) => acc + r.totalCost, 0);
    // Cena produktów "dla klienta" uzyskujemy przez mnożnik względem kosztów bazowych,
    // ale docelowo tak, żeby suma = productsTarget
    const productMultiplier = baseSumCosts > 0 ? productsTarget / baseSumCosts : 1;

    const rows = groupedCostsBase.map((r) => {
      const unit = r.unitCost * productMultiplier;
      const total = r.totalCost * productMultiplier;
      return [r.name, String(r.qty), fmtPLN(unit), fmtPLN(total)];
    });

    // dodatkowe pozycje
    const extraRows: any[] = [];
    if (packaging > 0) extraRows.push(["Opakowanie", "1", fmtPLN(packaging), fmtPLN(packaging)]);
    if (shippingCost > 0) extraRows.push([`Dostawa (${shippingSize})`, "1", fmtPLN(shippingCost), fmtPLN(shippingCost)]);

    const doc = new jsPDF({ unit: "mm", format: "a4" });

    doc.setFontSize(16);
    doc.text("WYCENA - LASER CO2", 14, 16);

    doc.setFontSize(10);
    doc.text(`Numer: ${id}`, 14, 24);
    doc.text(`Data: ${date} ${time}`, 14, 29);
    doc.text(`Materiał: ${selectedMaterial.name}`, 14, 34);

    autoTable(doc, {
      startY: 42,
      head: [["Pozycja", "Ilość", "Cena / szt", "Suma"]],
      body: rows.length ? [...rows, ...extraRows] : [["(brak)", "-", "-", "-"]],
      styles: { fontSize: 10 },
      headStyles: { fillColor: [240, 240, 240], textColor: 20 },
    });

    const y = (doc as any).lastAutoTable?.finalY ?? 42;

    doc.setFontSize(11);
    doc.text(`RAZEM: ${fmtPLN(sellPriceGross)}`, 14, y + 10);

    doc.setFontSize(8);
    doc.text("Wycena orientacyjna. Termin realizacji do ustalenia.", 14, y + 18);

    doc.save(`${id}-wycena.pdf`);
  }

  /* =========================
     UI
     ========================= */
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <div className="max-w-6xl mx-auto p-4 md:p-8">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold">Kalkulator wyceny + nesting (CO2 / sklejka)</h1>
            <p className="text-sm text-zinc-600 mt-1">
              Importuj SVG, ustaw skale i ilosci, a aplikacja ulozy projekty na arkuszu i policzy wycene + zysk (Allegro/VAT/podatek/dostawa).
            </p>
          </div>

          <div className="flex gap-2 flex-wrap">
            <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white shadow-sm border border-zinc-200 cursor-pointer">
              <input type="file" accept="image/svg+xml" multiple className="hidden" onChange={(e) => onAddSvg(e.target.files)} />
              <span className="text-sm font-medium">Wgraj SVG</span>
            </label>

            <button
              className="px-3 py-2 rounded-xl bg-white shadow-sm border border-zinc-200 text-sm font-medium disabled:opacity-50"
              disabled={!nesting.ok}
              onClick={exportLayoutSvg}
            >
              Eksport ulozenia (SVG)
            </button>

            <button
              className="px-3 py-2 rounded-xl bg-white shadow-sm border border-zinc-200 text-sm font-medium"
              onClick={exportPdfClient}
            >
              PDF dla klienta
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-6">
          {/* Left: settings */}
          <div className="lg:col-span-1 flex flex-col gap-4">
            <Card title="Parametry arkusza">
              <Row label="Szerokosc arkusza (mm)">
                <NumberInput value={sheetW} onChange={setSheetW} min={1} />
              </Row>
              <Row label="Wysokosc arkusza (mm)">
                <NumberInput value={sheetH} onChange={setSheetH} min={1} />
              </Row>
              <Row label="Odstep miedzy projektami (mm)">
                <NumberInput value={padding} onChange={setPadding} min={0} step={0.5} />
              </Row>
              <Row label="Kerf (mm) (informacyjnie)">
                <NumberInput value={kerf} onChange={setKerf} min={0} step={0.01} />
              </Row>

              <Row label="Material">
                <select
                  className="w-full px-3 py-2 rounded-xl border border-zinc-200 bg-white text-sm"
                  value={materialId}
                  onChange={(e) => setMaterialId(e.target.value)}
                >
                  {materials.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </Row>

              <Row label="Zoom podgladu">
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={0.5}
                    max={2}
                    step={0.1}
                    value={viewScale}
                    onChange={(e) => setViewScale(Number(e.target.value))}
                    className="w-full"
                  />
                  <span className="text-sm tabular-nums w-12 text-right">{viewScale.toFixed(1)}x</span>
                </div>
              </Row>
            </Card>

            <Card title="Koszty produkcji (PLN)">
              <Row label="Cena arkusza (dla wybranego materialu)">
                <NumberInput value={sheetCost} onChange={setSheetCostForSelected} min={0} step={0.1} />
              </Row>

              <Row label="Cena pradu (PLN/kWh)">
                <NumberInput value={powerPrice} onChange={setPowerPrice} min={0} step={0.01} />
              </Row>
              <Row label="Amortyzacja (PLN/h)">
                <NumberInput value={deprPerHour} onChange={setDeprPerHour} min={0} step={0.1} />
              </Row>
              <Row label="Godzina pracy (PLN/h)">
                <NumberInput value={laborPerHour} onChange={setLaborPerHour} min={0} step={0.1} />
              </Row>
            </Card>

            <Card title="Dostawa / opakowanie / Allegro / podatki">
              <Row label="Gabaryt dostawy">
                <div className="flex flex-col gap-2">
                  <Radio name="ship" label="Brak" checked={shippingSize === "none"} onChange={() => setShippingSize("none")} />
                  <Radio name="ship" label="A" checked={shippingSize === "A"} onChange={() => setShippingSize("A")} />
                  <Radio name="ship" label="B" checked={shippingSize === "B"} onChange={() => setShippingSize("B")} />
                  <Radio name="ship" label="C" checked={shippingSize === "C"} onChange={() => setShippingSize("C")} />
                </div>
              </Row>

              <Row label="Koszt dostawy A (PLN)">
                <NumberInput value={shippingCostA} onChange={setShippingCostA} min={0} step={0.5} />
              </Row>
              <Row label="Koszt dostawy B (PLN)">
                <NumberInput value={shippingCostB} onChange={setShippingCostB} min={0} step={0.5} />
              </Row>
              <Row label="Koszt dostawy C (PLN)">
                <NumberInput value={shippingCostC} onChange={setShippingCostC} min={0} step={0.5} />
              </Row>

              <Row label="Koszt opakowania (PLN)">
                <NumberInput value={packagingCost} onChange={setPackagingCost} min={0} step={0.5} />
              </Row>

              <Row label="Oplata Allegro (%)">
                <NumberInput value={allegroFeePercent} onChange={setAllegroFeePercent} min={0} step={0.1} />
              </Row>

              <Row label="Podatek (8.5%)">
                <div className="text-sm tabular-nums text-right w-full">{fmtPLN(tax85)}</div>
              </Row>

              <Row label="VAT (wg wzoru)">
                <div className="text-sm tabular-nums text-right w-full">{fmtPLN(vatCalc)}</div>
              </Row>

              <p className="text-xs text-zinc-600 mt-2">
                Allegro jest kosztem (odejmowane w zysku). VAT liczony jako: VAT(sprzedaż) - VAT(allegro) - VAT(materiał) - VAT(opakowanie).
              </p>
            </Card>

            <Card title="Cena sprzedaży">
              <Row label="Marza (%)">
                <NumberInput value={marginPercent} onChange={setMarginPercent} min={0} step={1} />
              </Row>
              <Row label="Minimalna cena (PLN)">
                <NumberInput value={minOrderPrice} onChange={setMinOrderPrice} min={0} step={1} />
              </Row>
              <Stat label="Cena końcowa (sprzedaż)" value={fmtPLN(sellPriceGross)} />
              <Stat label="Zysk (po Allegro/podatkach/VAT)" value={fmtPLN(profit)} />
            </Card>

            <Card title="Model czasu i energii (uproczony)">
              <Row label="Laser (W)">
                <NumberInput value={laserWatt} onChange={setLaserWatt} min={0} step={1} />
              </Row>
              <Row label="Dodatkowe odbiorniki (W)">
                <NumberInput value={assistWatt} onChange={setAssistWatt} min={0} step={1} />
              </Row>
              <Row label="Setup na zamowienie (min)">
                <NumberInput value={setupMinutes} onChange={setSetupMinutes} min={0} step={1} />
              </Row>
              <Row label="Czas na sztuke (min) (domyslnie)">
                <NumberInput value={baseMinutesPerItem} onChange={setBaseMinutesPerItem} min={0} step={0.5} />
              </Row>
            </Card>
          </div>

          {/* Right: preview + projects */}
          <div className="lg:col-span-2 flex flex-col gap-4">
            <Card title="Ulozenie na arkuszu">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm text-zinc-700">
                  {nesting.ok ? (
                    <span>
                      Instancje: <b>{instances.length}</b> • Zajete bbox: <b>{(totalArea / 1e6).toFixed(3)} m2</b> • Arkusz:{" "}
                      <b>{(sheetArea / 1e6).toFixed(3)} m2</b>
                    </span>
                  ) : (
                    <span className="text-rose-700">Nie miesci sie na arkuszu — zmniejsz skale/ilosci lub zwieksz arkusz.</span>
                  )}
                </div>
                <div className="text-sm text-zinc-700 tabular-nums">
                  Szac. czas: <b>{timeAndEnergyTotals.minutes.toFixed(0)} min</b> • Energia:{" "}
                  <b>{timeAndEnergyTotals.kwh.toFixed(2)} kWh</b>
                </div>
              </div>

              <div className="mt-3 overflow-auto rounded-xl border border-zinc-200 bg-white">
                <canvas ref={canvasRef} />
              </div>

              <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3">
                <Stat label="Arkusze (ceil)" value={`${sheetsNeeded || 0} szt`} />
                <Stat label="Materiał (zamówienie)" value={fmtPLN(materialCostOrder)} />
                <Stat label="Czas+energia" value={fmtPLN(orderCostsTime.total)} />
                <Stat label="Koszt produkcji" value={fmtPLN(productionCost)} />
              </div>

              <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3">
                <Stat label="Dostawa" value={fmtPLN(shippingCost)} />
                <Stat label="Opakowanie" value={fmtPLN(packaging)} />
                <Stat label="Allegro" value={fmtPLN(allegroFee)} />
                <Stat label="Sprzedaż (cena)" value={fmtPLN(sellPriceGross)} />
              </div>
            </Card>

            <Card title="Projekty (skala, ilosc, czas)">
              {designs.length === 0 ? (
                <div className="text-sm text-zinc-600">
                  Wgraj jeden lub kilka plikow SVG (np. eksport z LightBurn). Najlepiej, gdy SVG ma poprawny viewBox.
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {designs.map((d) => {
                    const w = d.baseW * d.scale;
                    const h = d.baseH * d.scale;
                    return (
                      <div key={d.id} className="rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="font-medium">{d.name}</div>
                            <div className="text-xs text-zinc-600 tabular-nums">
                              Rozmiar: {w.toFixed(1)} x {h.toFixed(1)} • baza: {d.baseW.toFixed(1)} x {d.baseH.toFixed(1)}
                            </div>
                          </div>
                          <button
                            className="text-sm px-3 py-1.5 rounded-xl border border-zinc-200 hover:bg-zinc-50"
                            onClick={() => removeDesign(d.id)}
                          >
                            Usun
                          </button>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
                          <Labeled label="Skala">
                            <div className="flex items-center gap-2">
                              <input
                                type="range"
                                min={0.1}
                                max={3}
                                step={0.05}
                                value={d.scale}
                                onChange={(e) => updateDesign(d.id, { scale: clamp(Number(e.target.value), 0.05, 10) })}
                                className="w-full"
                              />
                              <span className="text-sm tabular-nums w-14 text-right">{d.scale.toFixed(2)}x</span>
                            </div>
                          </Labeled>

                          <Labeled label="Ilosc">
                            <NumberInput
                              value={d.qty}
                              onChange={(v) => updateDesign(d.id, { qty: Math.max(1, Math.floor(v)) })}
                              min={1}
                              step={1}
                            />
                          </Labeled>

                          <Labeled label="Czas / szt (min) (opcjonalnie)">
                            <NumberInput
                              value={d.minutesOverride ?? 0}
                              onChange={(v) => updateDesign(d.id, { minutesOverride: v <= 0 ? undefined : v })}
                              min={0}
                              step={0.5}
                            />
                          </Labeled>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card title="Koszty per projekt (baza)">
              {groupedCostsBase.length === 0 ? (
                <div className="text-sm text-zinc-600">Dodaj projekty, aby zobaczyc koszty.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-zinc-600">
                        <th className="py-2">Projekt</th>
                        <th className="py-2">Ilosc</th>
                        <th className="py-2">Koszt / szt</th>
                        <th className="py-2">Koszt suma</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupedCostsBase.map((r) => (
                        <tr key={r.designId} className="border-t border-zinc-200">
                          <td className="py-2 font-medium">{r.name}</td>
                          <td className="py-2 tabular-nums">{r.qty}</td>
                          <td className="py-2 tabular-nums">{r.unitCost.toFixed(2)} PLN</td>
                          <td className="py-2 tabular-nums">{r.totalCost.toFixed(2)} PLN</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="text-xs text-zinc-600 mt-2">
                Materiał rozbijany proporcjonalnie do pola bbox, ale suma materiału = koszt materiału zamówienia (arkusze * cena).
              </p>
            </Card>
          </div>
        </div>

        <div className="mt-8 text-xs text-zinc-500">
          <p>Uwaga: VAT i 8.5% zależą od Twojego rozliczania (brutto/netto, faktury kosztowe). Ten model trzyma Twoje założenia 1:1.</p>
        </div>
      </div>
    </div>
  );
}

/* =========================
   UI bits
   ========================= */
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl bg-white border border-zinc-200 shadow-sm p-4">
      <div className="font-semibold">{title}</div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="text-sm text-zinc-700">{label}</div>
      <div className="w-40">{children}</div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-zinc-600 mb-1">{label}</div>
      {children}
    </div>
  );
}

function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <input
      className="w-full px-3 py-2 rounded-xl border border-zinc-200 bg-white text-sm tabular-nums"
      type="number"
      value={Number.isFinite(value) ? value : 0}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-3">
      <div className="text-xs text-zinc-600">{label}</div>
      <div className="text-base font-semibold tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

function Radio({
  name,
  label,
  checked,
  onChange,
}: {
  name: string;
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="inline-flex items-center gap-2 cursor-pointer select-none">
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      <span className="text-sm">{label}</span>
    </label>
  );
}

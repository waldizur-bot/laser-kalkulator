import React, { useEffect, useMemo, useRef, useState } from "react";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import {
  Scissors, Settings2, Zap, ShoppingBag, TrendingUp, Trash2, Plus, FileText,
  Download, Edit3, RotateCw, X, Move, RefreshCw, MousePointer2, Clock
} from "lucide-react";

// --- HELPERS ---

function mmToPx(mm: number, scale: number) { return mm * scale; }
function pxToMm(px: number, scale: number) { return px / scale; }
function clamp(n: number, a: number, b: number) { return Math.max(a, Math.min(b, n)); }
function fmtPLN(n: number) { return `${(n || 0).toFixed(2)} PLN`; }
function makeId() { return Math.random().toString(36).slice(2, 9); }

function nowStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return { date: `${yyyy}-${mm}-${dd}`, time: `${hh}:${mi}`, id: `WYC-${yyyy}${mm}${dd}-${hh}${mi}` };
}

function vatFromGross(gross: number, vatRate = 0.23) {
  const g = Math.max(0, gross);
  return (g * vatRate) / (1 + vatRate);
}

function isColliding(r1: any, r2: any) {
  return !(r2.x >= r1.x + r1.w || 
           r2.x + r2.w <= r1.x || 
           r2.y >= r1.y + r1.h || 
           r2.y + r2.h <= r1.y);
}

function parseSvgSize(svgText: string): { w: number; h: number } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgText, "image/svg+xml");
  const svg = doc.querySelector("svg");
  if (!svg) return { w: 100, h: 100 };
  const vb = svg.getAttribute("viewBox");
  if (vb) {
    const parts = vb.split(/[ ,]+/).map((x) => parseFloat(x)).filter((n) => !isNaN(n));
    if (parts.length === 4) return { w: parts[2], h: parts[3] };
  }
  return { 
    w: parseFloat(svg.getAttribute("width") || "100"), 
    h: parseFloat(svg.getAttribute("height") || "100") 
  };
}

// --- NESTING ALGORITHM (Guillotine) ---

type Node = { x: number; y: number; w: number; h: number; used: boolean; down: Node | null; right: Node | null };

function fit(node: Node, w: number, h: number): Node | null {
    if (node.used) return fit(node.right!, w, h) || fit(node.down!, w, h);
    else if (w <= node.w && h <= node.h) return node;
    return null;
}

function splitNode(node: Node, w: number, h: number) {
    node.used = true;
    node.down = { x: node.x, y: node.y + h, w: node.w, h: node.h - h, used: false, down: null, right: null };
    node.right = { x: node.x + w, y: node.y, w: node.w - w, h: h, used: false, down: null, right: null };
    return node;
}

function packGuillotine(items: any[], binW: number, binH: number, allowRotation: boolean) {
  const root: Node = { x: 0, y: 0, w: binW, h: binH, used: false, down: null, right: null };
  const placed: any[] = [];
  const sorted = [...items].sort((a, b) => (b.w * b.h) - (a.w * a.h));
  
  for (const item of sorted) {
      const w = item.w + item.pad * 2;
      const h = item.h + item.pad * 2;
      let node = fit(root, w, h);
      let rotated = false;

      if (allowRotation) {
          const nodeR = fit(root, h, w);
          if (nodeR && (!node || (nodeR.y < node.y) || (nodeR.y === node.y && nodeR.x < node.x))) {
              node = nodeR;
              rotated = true;
          }
      }

      if (node) {
          splitNode(node, rotated ? h : w, rotated ? w : h);
          placed.push({ ...item, x: node.x + item.pad, y: node.y + item.pad, rotated });
      } else {
          placed.push({ ...item, x: 0, y: binH + 10, rotated: false, error: true });
      }
  }
  return placed;
}

// --- TYPES & CONSTANTS ---

type Design = { id: string; name: string; svgText: string; baseW: number; baseH: number; scale: number; qty: number; minutesOverride?: number; };
type LayoutItem = { instanceId: string; designId: string; x: number; y: number; w: number; h: number; rotated: boolean; error?: boolean };
type MaterialProfile = { id: string; name: string; sheetCost: number; defaultW: number; defaultH: number; };

const MATERIALS_DEFAULT: MaterialProfile[] = [
  { id: "plywood_3", name: "Sklejka 3 mm", sheetCost: 20, defaultW: 600, defaultH: 400 },
  { id: "hdf_3", name: "HDF 3 mm", sheetCost: 10, defaultW: 800, defaultH: 600 },
];

type ShippingSize = "none" | "A" | "B" | "C";

// --- MAIN APP ---

export default function App() {
  // STATE: Materials
  const [materials, setMaterials] = useState<MaterialProfile[]>(() => {
      try { return JSON.parse(localStorage.getItem("materials_v3") || "") || MATERIALS_DEFAULT; } 
      catch { return MATERIALS_DEFAULT; }
  });
  const [materialId, setMaterialId] = useState<string>(materials[0].id);
  const [isEditingMaterials, setIsEditingMaterials] = useState(false);

  // STATE: Sheet
  const [sheetW, setSheetW] = useState(materials[0].defaultW);
  const [sheetH, setSheetH] = useState(materials[0].defaultH);
  const [padding, setPadding] = useState(2);
  const [allowRotation, setAllowRotation] = useState(true);

  // STATE: Costs
  const [powerPrice, setPowerPrice] = useState(1.1);
  const [deprPerHour, setDeprPerHour] = useState(1.2);
  const [laborPerHour, setLaborPerHour] = useState(35);

  // STATE: Pricing
  const [pricingMode, setPricingMode] = useState<"margin" | "fixed">("margin");
  const [marginPercent, setMarginPercent] = useState(200);
  const [fixedProductPriceGross, setFixedProductPriceGross] = useState(50);
  const [minOrderPrice, setMinOrderPrice] = useState(20);

  // STATE: Machine
  const [laserWatt, setLaserWatt] = useState(100);
  const [assistWatt, setAssistWatt] = useState(1000);
  const [setupMinutes, setSetupMinutes] = useState(5);
  const [baseMinutesPerItem, setBaseMinutesPerItem] = useState(2);

  // STATE: Logistics
  const [shippingSize, setShippingSize] = useState<ShippingSize>("none");
  const [shippingPrices, setShippingPrices] = useState({ A: 15, B: 20, C: 30 });
  const [packaging, setPackaging] = useState(5);
  const [allegroFeePercent, setAllegroFeePercent] = useState(10);

  // STATE: Data
  const [designs, setDesigns] = useState<Design[]>([]);
  const [layout, setLayout] = useState<LayoutItem[]>([]);
  
  // STATE: UI
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [viewScale, setViewScale] = useState(1.0);
  const [isPdfLoading, setIsPdfLoading] = useState(false);
  const [dragState, setDragState] = useState<{ id: string, startX: number, startY: number, initItemX: number, initItemY: number } | null>(null);

  // --- EFFECTS ---

  useEffect(() => { localStorage.setItem("materials_v3", JSON.stringify(materials)); }, [materials]);

  const selectedMaterial = useMemo(() => materials.find((m) => m.id === materialId) ?? materials[0], [materials, materialId]);

  const handleMaterialChange = (newId: string) => {
      setMaterialId(newId);
      const mat = materials.find(m => m.id === newId);
      if (mat) { setSheetW(mat.defaultW); setSheetH(mat.defaultH); }
  };

  // Sync Layout
  useEffect(() => {
      const neededInstances: LayoutItem[] = [];
      designs.forEach(d => {
          for(let i=0; i<d.qty; i++) {
              const instanceId = `${d.id}__${i}`;
              const existing = layout.find(l => l.instanceId === instanceId);
              const w = d.baseW * d.scale;
              const h = d.baseH * d.scale;
              if (existing) { neededInstances.push({ ...existing, w, h }); } 
              else { neededInstances.push({ instanceId, designId: d.id, x: 0, y: 0, w, h, rotated: false }); }
          }
      });
      if (neededInstances.length !== layout.length || neededInstances.some((n, i) => n.w !== layout[i]?.w)) {
          setLayout(neededInstances);
      }
      // eslint-disable-next-line
  }, [designs]);

  // --- LOGIC ---

  const runAutoNest = () => {
      const itemsToPack = layout.map(l => ({ ...l, pad: padding }));
      const packed = packGuillotine(itemsToPack, sheetW, sheetH, allowRotation);
      setLayout(packed.map((p: any) => ({
          instanceId: p.instanceId, designId: p.designId, x: p.x, y: p.y, w: p.w, h: p.h, rotated: p.rotated, error: p.error
      })));
  };

  // Canvas Interactions
  const getMousePos = (e: React.MouseEvent) => {
      if (!canvasRef.current) return { x: 0, y: 0 };
      const rect = canvasRef.current.getBoundingClientRect();
      const scaleX = canvasRef.current.width / rect.width;
      const scaleY = canvasRef.current.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;
      const s = Math.min(800/sheetW, 500/sheetH) * viewScale;
      return { x: pxToMm(x, s), y: pxToMm(y, s) };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
      const { x, y } = getMousePos(e);
      for (let i = layout.length - 1; i >= 0; i--) {
          const l = layout[i];
          const itemW = l.rotated ? l.h : l.w;
          const itemH = l.rotated ? l.w : l.h;
          if (x >= l.x && x <= l.x + itemW && y >= l.y && y <= l.y + itemH) {
              setDragState({ id: l.instanceId, startX: x, startY: y, initItemX: l.x, initItemY: l.y });
              return;
          }
      }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
      if (!dragState) return;
      const { x, y } = getMousePos(e);
      const dx = x - dragState.startX;
      const dy = y - dragState.startY;
      setLayout(prev => prev.map(l => {
          if (l.instanceId === dragState.id) return { ...l, x: dragState.initItemX + dx, y: dragState.initItemY + dy };
          return l;
      }));
  };

  const handleMouseUp = () => setDragState(null);
  const handleDoubleClick = (e: React.MouseEvent) => {
      const { x, y } = getMousePos(e);
      for (let i = layout.length - 1; i >= 0; i--) {
          const l = layout[i];
          const itemW = l.rotated ? l.h : l.w;
          const itemH = l.rotated ? l.w : l.h;
          if (x >= l.x && x <= l.x + itemW && y >= l.y && y <= l.y + itemH) {
             setLayout(prev => prev.map(item => item.instanceId === l.instanceId ? { ...item, rotated: !item.rotated } : item));
             return;
          }
      }
  };

  // Calculations
  const totalArea = layout.reduce((acc, l) => acc + (l.w * l.h), 0);
  const sheetArea = sheetW * sheetH;
  
  const collisions = useMemo(() => {
      const colSet = new Set<string>();
      const items = layout.map(l => ({ id: l.instanceId, x: l.x, y: l.y, w: l.rotated ? l.h : l.w, h: l.rotated ? l.w : l.h }));
      for(let i=0; i<items.length; i++) {
          if (items[i].x < 0 || items[i].y < 0 || items[i].x + items[i].w > sheetW || items[i].y + items[i].h > sheetH) colSet.add(items[i].id);
          for(let j=i+1; j<items.length; j++) {
              if (isColliding(items[i], items[j])) { colSet.add(items[i].id); colSet.add(items[j].id); }
          }
      }
      return colSet;
  }, [layout, sheetW, sheetH]);

  const materialUsage = clamp(totalArea / Math.max(1e-9, sheetArea), 0, 1);
  const materialCostOrder = selectedMaterial.sheetCost * materialUsage;

  const timeAndEnergyTotals = useMemo(() => {
    let minutes = setupMinutes;
    for (const l of layout) {
      const d = designs.find((x) => x.id === l.designId);
      minutes += d?.minutesOverride ?? baseMinutesPerItem;
    }
    const hours = minutes / 60;
    const kwh = ((laserWatt + assistWatt) / 1000) * hours;
    return { minutes, hours, kwh };
  }, [layout, designs, baseMinutesPerItem, setupMinutes, laserWatt, assistWatt]);

  const orderCostsTime = (timeAndEnergyTotals.kwh * powerPrice) + (timeAndEnergyTotals.hours * deprPerHour) + (timeAndEnergyTotals.hours * laborPerHour);
  const productionCost = orderCostsTime + materialCostOrder;

  const shippingCost = useMemo(() => {
    if (shippingSize === "A") return shippingPrices.A;
    if (shippingSize === "B") return shippingPrices.B;
    if (shippingSize === "C") return shippingPrices.C;
    return 0;
  }, [shippingSize, shippingPrices]);

  const baseForPricing = productionCost + packaging;

  const productPriceGross = useMemo(() => {
    if (pricingMode === "fixed") return Math.max(fixedProductPriceGross, minOrderPrice);
    return Math.max(baseForPricing * (1 + marginPercent / 100), minOrderPrice);
  }, [pricingMode, fixedProductPriceGross, baseForPricing, marginPercent, minOrderPrice]);

  const customerPaysGross = productPriceGross + shippingCost;
  const allegroFee = (allegroFeePercent / 100) * customerPaysGross;
  const tax85 = customerPaysGross * 0.085;
  const profit = customerPaysGross - (materialCostOrder + packaging + shippingCost + tax85 + vatFromGross(customerPaysGross) - vatFromGross(allegroFee) - vatFromGross(materialCostOrder) - vatFromGross(packaging) + orderCostsTime + allegroFee);

  // --- PDF EXPORT ---
  async function exportPdfClient() {
    setIsPdfLoading(true);
    try {
        const { id, date } = nowStamp();
        const doc = new jsPDF({ unit: "mm" });
        
        try {
            const fontBytes = await fetch("https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.1.66/fonts/Roboto/Roboto-Regular.ttf").then(r => r.arrayBuffer());
            const binary = new Uint8Array(fontBytes).reduce((acc, byte) => acc + String.fromCharCode(byte), '');
            doc.addFileToVFS("Roboto.ttf", btoa(binary));
            doc.addFont("Roboto.ttf", "Roboto", "normal");
            doc.setFont("Roboto");
        } catch(e) { console.warn("Font loading failed", e); }

        doc.setFontSize(18); doc.text("OFERTA", 14, 20);
        doc.setFontSize(10); doc.text(`Data: ${date}`, 14, 26);

        const groupedRows = layout.reduce((acc: any[], curr) => {
             const d = designs.find(x => x.id === curr.designId);
             if(!d) return acc;
             const exist = acc.find(r => r[0] === d.name);
             if(exist) { exist[1] = String(Number(exist[1])+1); }
             else { acc.push([d.name, "1", "-", "-"]); }
             return acc;
        }, []);

        const itemPrice = layout.length ? (productPriceGross / layout.length) : 0;
        groupedRows.forEach(r => { 
            const count = Number(r[1]);
            r[2] = fmtPLN(itemPrice); 
            r[3] = fmtPLN(itemPrice * count); 
        });

        autoTable(doc, { 
            startY: 35, 
            head: [["Element", "Ilość", "Cena jedn.", "Razem"]], 
            body: groupedRows, 
            styles: { font: "Roboto", fontStyle: "normal" },
            headStyles: { font: "Roboto", fontStyle: "normal", fillColor: [79, 70, 229] }
        });
        
        let y = (doc as any).lastAutoTable.finalY + 10;
        doc.text(`Dostawa: ${fmtPLN(shippingCost)}`, 14, y);
        doc.setFontSize(14);
        doc.text(`RAZEM: ${fmtPLN(customerPaysGross)}`, 14, y + 10);
        
        doc.save(`oferta_${id}.pdf`);
    } finally { setIsPdfLoading(false); }
  }

  function exportLayoutSvg() {
    if (!layout.length) return;
    const body: string[] = [];
    body.push(`<rect x="0" y="0" width="${sheetW}" height="${sheetH}" fill="none" stroke="black" stroke-width="1"/>`);
    // @ts-ignore
    for (const p of layout) {
      const d = designs.find((x) => x.id === p.designId);
      if (!d) continue;
      const inner = d.svgText.replace(/^[\s\S]*?<svg[^>]*>/i, "").replace(/<\/svg>[\s\S]*$/i, "");
      const transform = p.rotated 
        ? `translate(${p.x + p.h} ${p.y}) rotate(90) scale(${d.scale})`
        : `translate(${p.x} ${p.y}) scale(${d.scale})`;
      body.push(`<g transform="${transform}">${inner}</g>`);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}mm" height="${sheetH}mm" viewBox="0 0 ${sheetW} ${sheetH}">${body.join('\n')}</svg>`;
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `nesting_${makeId()}.svg`; a.click();
  }

  // --- RENDER ---

  return (
    <div className="min-h-screen bg-[#f8fafc] text-slate-900 font-sans select-none flex flex-col">
      <header className="bg-white border-b sticky top-0 z-50 px-6 py-3 flex justify-between items-center shadow-sm">
        <div className="flex items-center gap-3">
            <div className="bg-indigo-600 p-2 rounded text-white"><Scissors size={20}/></div>
            <h1 className="font-bold text-xl tracking-tight leading-none">
                <span className="text-slate-900">Wycena </span><span className="text-indigo-600">Cięcia</span>
            </h1>
        </div>
        <div className="flex gap-2">
            <button onClick={() => setIsEditingMaterials(!isEditingMaterials)} className="p-2 border rounded hover:bg-slate-50 flex items-center gap-2 text-sm font-medium"><Edit3 size={16}/> Materiały</button>
            <label className="bg-slate-900 text-white px-4 py-2 rounded-lg text-sm font-medium cursor-pointer flex items-center gap-2 hover:bg-slate-800"><Plus size={16}/> Dodaj SVG <input type="file" multiple accept=".svg" className="hidden" onChange={async (e) => {
                const files = Array.from(e.target.files || []);
                const newD = await Promise.all(files.map(async f => {
                    const t = await f.text(); const s = parseSvgSize(t);
                    return { id: makeId(), name: f.name.replace('.svg',''), svgText: t, baseW: s.w, baseH: s.h, scale: 1, qty: 1 };
                }));
                setDesigns([...designs, ...newD]);
            }} /></label>
        </div>
      </header>

      {isEditingMaterials && (
          <div className="fixed inset-0 bg-black/20 z-50 flex items-start justify-center pt-20 backdrop-blur-sm">
              <div className="bg-white rounded-xl shadow-2xl p-6 w-[600px] max-w-full">
                  <div className="flex justify-between items-center mb-4"><h3 className="font-bold text-lg">Edytor Materiałów</h3><button onClick={() => setIsEditingMaterials(false)}><X size={20}/></button></div>
                  <div className="space-y-2 max-h-[60vh] overflow-y-auto">
                      {materials.map((m, idx) => (
                          <div key={m.id} className="grid grid-cols-12 gap-2 items-center bg-slate-50 p-2 rounded">
                              <input className="col-span-4 bg-white border rounded px-2 py-1 text-sm" value={m.name} onChange={e => { const n = [...materials]; n[idx].name = e.target.value; setMaterials(n); }} />
                              <div className="col-span-2"><input type="number" className="w-full bg-white border rounded px-1 py-1 text-sm" value={m.sheetCost} onChange={e => { const n = [...materials]; n[idx].sheetCost = Number(e.target.value); setMaterials(n); }} /></div>
                              <div className="col-span-2"><input type="number" className="w-full bg-white border rounded px-1 py-1 text-sm" value={m.defaultW} onChange={e => { const n = [...materials]; n[idx].defaultW = Number(e.target.value); setMaterials(n); }} /></div>
                              <div className="col-span-2"><input type="number" className="w-full bg-white border rounded px-1 py-1 text-sm" value={m.defaultH} onChange={e => { const n = [...materials]; n[idx].defaultH = Number(e.target.value); setMaterials(n); }} /></div>
                              <button className="col-span-2 text-red-500 hover:bg-red-50 p-1 rounded" onClick={() => setMaterials(materials.filter(x => x.id !== m.id))}><Trash2 size={16}/></button>
                          </div>
                      ))}
                  </div>
                  <button onClick={() => setMaterials([...materials, { id: makeId(), name: "Nowy materiał", sheetCost: 0, defaultW: 600, defaultH: 400 }])} className="mt-4 w-full py-2 border border-dashed border-indigo-300 text-indigo-600 font-bold rounded flex justify-center gap-2"><Plus size={16}/> Dodaj Preset</button>
              </div>
          </div>
      )}

      <main className="flex-1 max-w-[1800px] mx-auto p-4 lg:p-6 grid grid-cols-12 gap-6 w-full">
        <div className="col-span-12 xl:col-span-3 space-y-4 overflow-y-auto h-full">
            <Section title="Materiał" icon={<Settings2 size={16}/>}>
                <div className="mb-3"><select className="w-full p-2 border rounded bg-slate-50 text-sm font-medium" value={materialId} onChange={e => handleMaterialChange(e.target.value)}>{materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div>
                <div className="grid grid-cols-2 gap-2 mb-2"><Input label="Szerokość" val={sheetW} set={setSheetW} /><Input label="Wysokość" val={sheetH} set={setSheetH} /></div>
                <div className="grid grid-cols-2 gap-2"><Input label="Padding" val={padding} set={setPadding} /><Input label="Koszt Ark." val={selectedMaterial.sheetCost} set={(v: number) => { const n = [...materials]; const idx = n.findIndex(x=>x.id===materialId); if(idx>-1) { n[idx].sheetCost = v; setMaterials(n); } }} /></div>
            </Section>

            <Section title="Parametry Lasera" icon={<Zap size={16}/>}>
                <div className="grid grid-cols-2 gap-2 mb-2"><Input label="Setup (min)" val={setupMinutes} set={setSetupMinutes} /><Input label="Czas/szt (min)" val={baseMinutesPerItem} set={setBaseMinutesPerItem} step={0.1} /></div>
                <div className="grid grid-cols-2 gap-2 mb-2"><Input label="Moc (W)" val={laserWatt} set={setLaserWatt} /><Input label="Assist (W)" val={assistWatt} set={setAssistWatt} /></div>
                <div className="space-y-2 pt-2 border-t">
                    <Input label="Prąd (PLN/kWh)" val={powerPrice} set={setPowerPrice} step={0.1}/>
                    <div className="grid grid-cols-2 gap-2">
                        <Input label="Amortyzacja/h" val={deprPerHour} set={setDeprPerHour}/>
                        <Input label="Robocizna/h" val={laborPerHour} set={setLaborPerHour}/>
                    </div>
                </div>
            </Section>

            <Section title="Logistyka" icon={<ShoppingBag size={16}/>}>
                <div className="grid grid-cols-2 gap-2 mb-2"><Input label="Opakowanie" val={packaging} set={setPackaging}/><Input label="Allegro %" val={allegroFeePercent} set={setAllegroFeePercent} step={0.1}/></div>
                <div className="mb-2 border-t pt-2">
                    <label className="text-[10px] font-bold text-slate-400 uppercase mb-1 block">Wybierz Gabaryt</label>
                    <div className="flex bg-slate-100 p-1 rounded mb-2">
                        {(['none','A','B','C'] as const).map(k => (
                            <button key={k} onClick={()=>setShippingSize(k)} className={`flex-1 text-xs py-1.5 rounded font-bold ${shippingSize===k ? 'bg-white shadow text-indigo-600':'text-slate-400'}`}>{k==='none'?'-':k}</button>
                        ))}
                    </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                     <div><label className="text-[9px] text-slate-400 block mb-0.5">Cena A</label><input type="number" className="w-full text-xs border rounded p-1" value={shippingPrices.A} onChange={e => setShippingPrices({...shippingPrices, A: Number(e.target.value)})} /></div>
                     <div><label className="text-[9px] text-slate-400 block mb-0.5">Cena B</label><input type="number" className="w-full text-xs border rounded p-1" value={shippingPrices.B} onChange={e => setShippingPrices({...shippingPrices, B: Number(e.target.value)})} /></div>
                     <div><label className="text-[9px] text-slate-400 block mb-0.5">Cena C</label><input type="number" className="w-full text-xs border rounded p-1" value={shippingPrices.C} onChange={e => setShippingPrices({...shippingPrices, C: Number(e.target.value)})} /></div>
                </div>
                <div className="mt-2 text-right text-xs text-indigo-600 font-bold">Koszt wysyłki: {fmtPLN(shippingCost)}</div>
            </Section>
        </div>

        <div className="col-span-12 xl:col-span-6 flex flex-col gap-4">
            <div className="bg-white rounded-xl border p-1 shadow-sm relative group overflow-hidden">
                <div className="bg-slate-100/50 rounded-lg flex justify-center items-center min-h-[500px] relative overflow-auto cursor-crosshair">
                    <div className="absolute inset-0 pointer-events-none opacity-[0.05]" style={{ backgroundImage: 'radial-gradient(#000 1px, transparent 1px)', backgroundSize: '20px 20px' }}></div>
                    <canvas 
                        ref={(c) => {
                            if(!c) return; canvasRef.current = c;
                            const ctx = c.getContext("2d"); if(!ctx) return;
                            const s = Math.min(800/sheetW, 500/sheetH) * viewScale;
                            c.width = sheetW * s; c.height = sheetH * s;
                            ctx.fillStyle = "white"; ctx.fillRect(0,0,c.width,c.height);
                            ctx.strokeStyle = "#94a3b8"; ctx.strokeRect(0,0,c.width,c.height);
                            
                            layout.forEach(l => {
                                 const w = mmToPx(l.rotated ? l.h : l.w, s);
                                 const h = mmToPx(l.rotated ? l.w : l.h, s);
                                 const x = mmToPx(l.x, s); const y = mmToPx(l.y, s);
                                 const isErr = collisions.has(l.instanceId) || l.error;
                                 ctx.fillStyle = isErr ? "#fecaca" : "#eff6ff"; 
                                 ctx.fillRect(x,y,w,h);
                                 ctx.strokeStyle = isErr ? "#ef4444" : "#3b82f6"; ctx.lineWidth = 2; ctx.strokeRect(x,y,w,h);
                                 const d = designs.find(ds => ds.id === l.designId);
                                 if(w>20 && d) { ctx.fillStyle= isErr ? "#991b1b" : "#1e3a8a"; ctx.font="10px sans-serif"; ctx.fillText(d.name.substring(0,6), x+2, y+10); }
                            });
                        }} 
                        className="shadow-lg transition-shadow"
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onDoubleClick={handleDoubleClick}
                    />
                </div>
                
                <div className="absolute top-4 right-4 flex gap-2">
                    <button onClick={runAutoNest} className="p-2 bg-indigo-600 text-white rounded shadow-sm text-xs font-bold flex items-center gap-2 hover:bg-indigo-700"><RefreshCw size={14}/> Auto Nest</button>
                    <div className="bg-white border rounded p-1 flex"><button onClick={()=>setViewScale(v=>Math.max(0.2, v-0.1))} className="px-2 font-bold">-</button><button onClick={()=>setViewScale(v=>Math.min(3, v+0.1))} className="px-2 font-bold">+</button></div>
                </div>
                <div className="absolute top-4 left-4 bg-white/80 backdrop-blur p-2 rounded text-[10px] text-slate-500 pointer-events-none flex items-center gap-2 border"><Move size={12}/> Przesuwaj • 2x Klik Obrót</div>
            </div>

            <div className="bg-white border rounded-xl p-4 shadow-sm flex-1 overflow-y-auto max-h-[300px]">
                <h3 className="font-bold text-slate-700 text-sm mb-2">Elementy ({designs.length})</h3>
                <div className="space-y-2">
                    {designs.map(d => (
                        <div key={d.id} className="flex items-center gap-3 bg-slate-50 p-2 rounded border">
                            <div className="w-8 h-8 bg-white border rounded flex items-center justify-center p-0.5"><div className="w-full h-full opacity-50 pointer-events-none" dangerouslySetInnerHTML={{ __html: d.svgText.replace(/width=".*?"/, 'width="100%"').replace(/height=".*?"/, 'height="100%"') }} /></div>
                            <div className="flex-1 text-xs font-bold text-slate-700">{d.name}</div>
                            
                            <div className="flex flex-col w-16">
                                <label className="text-[8px] text-slate-400 text-center">Czas(min)</label>
                                <input type="number" step="0.1" value={d.minutesOverride ?? ""} placeholder={String(baseMinutesPerItem)} onChange={e => { const val = e.target.value === "" ? undefined : Number(e.target.value); setDesigns(designs.map(x=>x.id===d.id?{...x,minutesOverride:val}:x)) }} className="text-center border rounded text-xs py-1" />
                            </div>

                            <div className="flex flex-col w-12">
                                <label className="text-[8px] text-slate-400 text-center">Sztuk</label>
                                <input type="number" value={d.qty} onChange={e=>setDesigns(designs.map(x=>x.id===d.id?{...x,qty:Number(e.target.value)}:x))} className="text-center border rounded text-xs py-1" />
                            </div>
                            <div className="flex flex-col w-12">
                                <label className="text-[8px] text-slate-400 text-center">Skala</label>
                                <input type="number" step="0.1" value={d.scale} onChange={e=>setDesigns(designs.map(x=>x.id===d.id?{...x,scale:Number(e.target.value)}:x))} className="text-center border rounded text-xs py-1" />
                            </div>
                            <button onClick={()=>setDesigns(designs.filter(x=>x.id!==d.id))} className="text-slate-400 hover:text-red-500"><Trash2 size={16}/></button>
                        </div>
                    ))}
                </div>
            </div>
        </div>

        <div className="col-span-12 xl:col-span-3 space-y-4">
            <div className="bg-white border rounded-xl p-4 shadow-sm relative overflow-hidden">
                <div className="bg-gradient-to-r from-indigo-500 to-purple-600 h-1 absolute top-0 left-0 right-0"></div>
                <div className="flex items-center gap-2 mb-3 text-indigo-700 font-bold uppercase text-xs tracking-wider"><TrendingUp size={16}/> Ceny</div>
                <div className="flex bg-slate-100 p-1 rounded mb-3">
                    <button onClick={()=>setPricingMode('margin')} className={`flex-1 py-1.5 text-xs font-bold rounded ${pricingMode==='margin'?'bg-white shadow text-indigo-700':'text-slate-500'}`}>MARŻA %</button>
                    <button onClick={()=>setPricingMode('fixed')} className={`flex-1 py-1.5 text-xs font-bold rounded ${pricingMode==='fixed'?'bg-white shadow text-indigo-700':'text-slate-500'}`}>STAŁA</button>
                </div>
                {pricingMode === 'margin' ? <Input label="Procent Marży" val={marginPercent} set={setMarginPercent} /> : <Input label="Cena Brutto (PLN)" val={fixedProductPriceGross} set={setFixedProductPriceGross} />}
            </div>

            <div className="bg-slate-900 rounded-xl p-6 text-white shadow-xl">
                <div className="text-slate-400 text-xs font-bold uppercase mb-1">Cena dla Klienta</div>
                <div className="text-3xl font-black">{fmtPLN(customerPaysGross)}</div>
                <div className="mt-6 space-y-2 border-t border-slate-700 pt-4">
                    <div className="flex justify-between text-base"><span className="text-emerald-400 font-bold">Twój Zysk:</span><span className="font-bold text-emerald-400">{fmtPLN(profit)}</span></div>
                </div>
            </div>

            <div className="bg-white border rounded-xl p-4 shadow-sm text-sm space-y-2">
                <Row label="Materiał" val={materialCostOrder} />
                <Row label="Praca/Maszyna" val={orderCostsTime} />
                <Row label="Podatki/Fee" val={tax85 + vatFromGross(customerPaysGross) + allegroFee} />
                <Row label="Logistyka" val={shippingCost + packaging} isLast />
            </div>

            <div className="grid grid-cols-2 gap-2">
                <button onClick={exportLayoutSvg} disabled={!layout.length} className="bg-white border rounded-xl p-3 flex flex-col items-center justify-center hover:bg-slate-50 disabled:opacity-50"><Download className="text-indigo-600 mb-1" size={20}/> <span className="text-xs font-bold">SVG</span></button>
                <button onClick={exportPdfClient} disabled={isPdfLoading} className="bg-indigo-600 text-white border border-indigo-600 rounded-xl p-3 flex flex-col items-center justify-center hover:bg-indigo-700"><FileText className="text-white mb-1" size={20}/> <span className="text-xs font-bold">{isPdfLoading?'...':'PDF'}</span></button>
            </div>
        </div>
      </main>
      <footer className="border-t border-slate-200 py-4 text-center text-xs text-slate-400 mt-auto">
          <p>© 2026 Waldemar Żurek. Wszelkie prawa zastrzeżone.</p>
      </footer>
    </div>
  );
}

function Section({title,icon,children}:any) { return <div className="bg-white border rounded-xl p-4 shadow-sm"><div className="flex items-center gap-2 mb-3 text-slate-400 font-bold text-xs uppercase">{icon}{title}</div>{children}</div> }
function Input({label,val,set,step}:any) { return <div><label className="block text-[10px] font-bold text-slate-400 uppercase mb-1">{label}</label><input type="number" step={step} value={val} onChange={e=>set(Number(e.target.value))} className="w-full border rounded p-1.5 text-sm font-bold text-slate-700 bg-slate-50 focus:bg-white focus:border-indigo-500 outline-none tabular-nums"/></div> }
function Row({label,val,isLast}:any) { return <div className={`flex justify-between ${!isLast?'border-b border-slate-50 pb-2':''} pt-1`}><span className="text-slate-500">{label}</span><span className="font-bold">{fmtPLN(val)}</span></div> }
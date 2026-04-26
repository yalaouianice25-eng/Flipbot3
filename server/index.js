const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9",
};

async function scrapeVinted(query, size = "") {
  try {
    const searchQuery = encodeURIComponent(`${query} ${size}`.trim());
    const url = `https://www.vinted.fr/catalog?search_text=${searchQuery}&order=relevance`;
    const response = await axios.get(url, { headers: HEADERS, timeout: 10000 });
    const $ = cheerio.load(response.data);
    const prices = [];
    const items = [];
    $('[data-testid="regular-item-box"]').each((i, el) => {
      const priceText = $(el).find('[data-testid="item-price"]').text().trim();
      const title = $(el).find('[data-testid="item-title"]').text().trim();
      const brand = $(el).find('[data-testid="item-details-brand"]').text().trim();
      const condition = $(el).find('[data-testid="item-details-condition"]').text().trim();
      const link = $(el).find("a").attr("href");
      const priceMatch = priceText.match(/[\d,\.]+/);
      if (priceMatch) {
        const price = parseFloat(priceMatch[0].replace(",", "."));
        if (price > 0 && price < 500) {
          prices.push(price);
          items.push({ price, title: title || query, brand, condition, link: link ? `https://www.vinted.fr${link}` : null });
        }
      }
    });
    return { prices, items: items.slice(0, 20) };
  } catch (error) {
    console.error("Erreur scraping:", error.message);
    return { prices: [], items: [] };
  }
}

async function analyzeWithGroq(itemInfo, marketData) {
  const systemPrompt = `Tu es un expert en flip Vinted. Retourne UNIQUEMENT ce JSON sans texte autour :
{
  "produit": { "marque": "...", "modele": "...", "taille": "...", "etat": "..." },
  "marche": { "prix_minimum": 0, "prix_median": 0, "prix_maximum": 0, "delai_revente_jours": 0, "demande": "forte" },
  "achat": { "prix_article": 0, "frais_livraison": 0, "frais_protection": 0, "cout_total_reel": 0 },
  "revente": { "prix_revente_conseille": 0, "prix_revente_min": 0, "prix_revente_max": 0, "marge_nette": 0, "rentabilite_pct": 0 },
  "verdict": { "decision": "ACHETE", "raison": "...", "prix_negociation_ideal": 0, "prix_negociation_minimum": 0, "prix_negociation_maximum": 0, "conseil": "..." }
}
REGLES: Base toi sur les prix reels fournis. Marge realiste 4-15 euros. Decision = ACHETE, NEGOCIE, ou PASSE uniquement.`;

  const userPrompt = `Article: ${itemInfo.title || ""} ${itemInfo.brand || ""}
Taille: ${itemInfo.size || ""} | Etat: ${itemInfo.condition || ""}
Prix: ${itemInfo.price}€ | Livraison: ${itemInfo.shipping}€ | Protection: ${itemInfo.buyerFees}€
COUT TOTAL: ${itemInfo.totalCost}€
PRIX REELS VINTED (${marketData.items.length} annonces): ${marketData.prices.join(", ")}€
Min: ${marketData.prices.length > 0 ? Math.min(...marketData.prices) : "N/A"}€
Median: ${marketData.prices.length > 0 ? [...marketData.prices].sort((a,b)=>a-b)[Math.floor(marketData.prices.length/2)] : "N/A"}€
Max: ${marketData.prices.length > 0 ? Math.max(...marketData.prices) : "N/A"}€`;

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    { model: "llama-3.3-70b-versatile", temperature: 0, max_tokens: 1500, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }] },
    { headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" }, timeout: 30000 }
  );

  const content = response.data.choices[0].message.content;
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) return JSON.parse(jsonMatch[0]);
  throw new Error("JSON invalide");
}

app.post("/api/analyze", async (req, res) => {
  try {
    const { url, description, price } = req.body;
    let itemInfo = { title: description || "", brand: "", size: "", condition: "", price: parseFloat(price) || 0, shipping: 3.99, buyerFees: 0, totalCost: 0 };
    if (itemInfo.price > 0) {
      itemInfo.buyerFees = parseFloat(Math.max(0.70, itemInfo.price * 0.05 + 0.70).toFixed(2));
      itemInfo.totalCost = parseFloat((itemInfo.price + itemInfo.shipping + itemInfo.buyerFees).toFixed(2));
    }
    const searchQuery = itemInfo.title || description || "";
    const marketData = await scrapeVinted(searchQuery, itemInfo.size);
    const analysis = await analyzeWithGroq(itemInfo, marketData);
    res.json({ success: true, itemInfo, marketData: { items: marketData.items, prices: marketData.prices, count: marketData.items.length }, analysis });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.use(express.static(path.join(__dirname, "../client/dist")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../client/dist/index.html")));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`FlipBot running on port ${PORT}`));

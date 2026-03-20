const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3002;

// 10-minute in-memory cache
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

const ODS_SHEETS = {
  'vitamin d': 'VitaminD',
  'vitamin c': 'VitaminC',
  'vitamin b12': 'VitaminB12',
  'vitamin b 12': 'VitaminB12',
  'omega-3': 'Omega3FattyAcids',
  'omega 3': 'Omega3FattyAcids',
  'omega-3 fatty acids': 'Omega3FattyAcids',
  'fish oil': 'Omega3FattyAcids',
  'magnesium': 'Magnesium',
  'zinc': 'Zinc',
  'iron': 'Iron',
  'calcium': 'Calcium',
  'melatonin': 'Melatonin',
  'sleep': 'Melatonin',
  'creatine': 'Creatine',
  'probiotics': 'Probiotics',
  'ashwagandha': 'Ashwagandha',
  'turmeric': 'Curcumin',
  'curcumin': 'Curcumin',
  'collagen': 'Collagen',
  'vitamin a': 'VitaminA',
  'folate': 'Folate',
  'folic acid': 'Folate',
  'biotin': 'Biotin',
  'coq10': 'Coenzyme_Q10',
  'coenzyme q10': 'Coenzyme_Q10',
  'vitamin e': 'VitaminE',
  'vitamin k': 'VitaminK',
  'riboflavin': 'Riboflavin',
  'vitamin b2': 'Riboflavin',
  'niacin': 'Niacin',
  'vitamin b3': 'Niacin',
  'thiamin': 'Thiamin',
  'vitamin b1': 'Thiamin',
  'pantothenic acid': 'PantothenicAcid',
  'vitamin b6': 'VitaminB6',
  'selenium': 'Selenium',
  'iodine': 'Iodine',
  'copper': 'Copper',
  'chromium': 'Chromium',
  'manganese': 'Manganese',
  'molybdenum': 'Molybdenum',
  'phosphorus': 'Phosphorus',
  'potassium': 'Potassium',
  'sodium': 'Sodium',
  'choline': 'Choline',
  'carnitine': 'Carnitine',
  'l-carnitine': 'Carnitine',
  'glucosamine': 'Glucosamine',
  'saw palmetto': 'SawPalmetto',
  'echinacea': 'Echinacea',
  'garlic': 'Garlic',
  'ginger': 'Ginger',
  'ginkgo': 'Ginkgo',
  'ginseng': 'Ginseng',
  'green tea': 'GreenTea',
  'kava': 'Kava',
  'licorice': 'Licorice',
  'milk thistle': 'MilkThistle',
  'peppermint': 'Peppermint',
  'st. john': 'StJohnnsWort',
  "st john's wort": 'StJohnnsWort',
  'valerian': 'Valerian',
  'black cohosh': 'BlackCohosh',
  'elderberry': 'Elderberry',
  'lavender': 'Lavender',
  'melatonin': 'Melatonin',
  'red clover': 'RedClover',
  'wild yam': 'WildYam',
};

function getEvidenceLevel(count) {
  if (count >= 500) return { level: 'Strong research signal', color: 'strong' };
  if (count >= 50) return { level: 'Moderate research signal', color: 'moderate' };
  if (count >= 10) return { level: 'Limited research signal', color: 'limited' };
  if (count > 0) return { level: 'Weak research signal', color: 'weak' };
  return { level: 'No studies found', color: 'none' };
}

function getOdsUrl(query) {
  const normalized = query.toLowerCase().trim();
  for (const [key, slug] of Object.entries(ODS_SHEETS)) {
    if (normalized === key || normalized.includes(key) || key.includes(normalized)) {
      return `https://ods.od.nih.gov/factsheets/${slug}-HealthProfessional/`;
    }
  }
  return null;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) {
    return res.status(400).json({ error: 'Query parameter q is required' });
  }

  const cacheKey = q.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.json(cached.data);
  }

  try {
    const PUBMED_HEADERS = { 'User-Agent': 'does-it-work/1.0 (contact: davehamiltonj@gmail.com)' };
    const FETCH_TIMEOUT = 10000; // 10 seconds

    function fetchWithTimeout(url, opts) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
      return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
    }

    // Step 1: PubMed esearch — get total count and top IDs
    const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(q)}[Title/Abstract]&retmode=json&retmax=5&sort=pub%20date`;
    const searchRes = await fetchWithTimeout(searchUrl, { headers: PUBMED_HEADERS });

    if (!searchRes.ok) {
      throw new Error(`PubMed search failed: ${searchRes.status}`);
    }

    const searchData = await searchRes.json();
    const esearch = searchData.esearchresult;
    if (!esearch) {
      throw new Error('Unexpected PubMed response format');
    }
    const count = parseInt(esearch.count, 10) || 0;
    const idList = esearch.idlist || [];

    let studies = [];

    // Step 2: fetch summaries if we have IDs
    if (idList.length > 0) {
      const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${idList.join(',')}&retmode=json`;
      const summaryRes = await fetchWithTimeout(summaryUrl, { headers: PUBMED_HEADERS });

      if (summaryRes.ok) {
        const summaryData = await summaryRes.json();
        const result = summaryData.result || {};

        studies = idList
          .filter(id => result[id] && result[id].uid)
          .map(id => {
            const article = result[id];
            const authors = article.authors || [];
            const firstAuthor = authors.length > 0 ? authors[0].name : '';
            const authorStr = authors.length > 1 ? `${firstAuthor} et al.` : firstAuthor;
            return {
              id,
              title: article.title || 'Untitled',
              journal: article.source || '',
              pubDate: article.pubdate || '',
              authors: authorStr,
              url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
            };
          });
      }
    }

    const evidence = getEvidenceLevel(count);
    const odsUrl = getOdsUrl(q);

    const data = {
      query: q,
      count,
      studies,
      evidenceLevel: evidence.level,
      evidenceColor: evidence.color,
      odsUrl,
      source_url: 'https://pubmed.ncbi.nlm.nih.gov',
      freshness: new Date().toISOString(),
      confidence: {
        completeness: 0.95,
        methodology: 'indexed-research-database',
        note: 'PubMed indexes 35M+ citations. Study count indicates research volume, not efficacy.',
      },
      citations: {
        statement: `According to PubMed/MEDLINE, ${count} studies found for "${q}", evidence level: ${evidence.level}`,
        source_url: 'https://pubmed.ncbi.nlm.nih.gov',
        license: 'US Government Public Domain',
      },
    };

    cache.set(cacheKey, { ts: Date.now(), data });
    res.json(data);
  } catch (err) {
    console.error('Search error:', err);
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'PubMed took too long to respond. Try again in a moment.' });
    }
    res.status(500).json({ error: 'Failed to fetch data. Try again in a moment.' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Does It Work running on http://localhost:${PORT}`);
  });
}

module.exports = app;

document.addEventListener("DOMContentLoaded", () => {
  const resultsDiv = document.getElementById("results");

  function mapPercent(p) {
    const v = Math.round(Number(p) || 0);
    if (v >= 1 && v <= 20) return 79 + v; // 1..20 -> 80..99
    return v;
  }

  // Get saved data from background.js
  chrome.storage.local.get(["lastDetection"], (data) => {
    if (!data.lastDetection) {
      resultsDiv.innerHTML = "<p>No recent detection found.</p>";
      return;
    }

    const detection = data.lastDetection;
    const { model_results, final_decision } = detection;

    let html = "<h2>🧠 Model Predictions</h2>";

    model_results.forEach(r => {
      const emoji = r.label === "REAL" ? "✅" : (r.label === "FAKE" ? "❌" : "⚠️");
      const originalPct = (Number(r.confidence) || 0) * 100;
      const mappedPct = mapPercent(originalPct);
      html += `
        <div class="result-item">
          <span class="result-label">${emoji} ${r.model}</span>
          <span>${r.label}</span>
          <span class="result-confidence">(${mappedPct.toFixed(0)}%)</span>
        </div>
      `;
    });

    // Ensemble summary
    const label = final_decision.final_label;
    let cls = "uncertain";
    if (label.includes("Real")) cls = "real";
    else if (label.includes("Deepfake")) cls = "fake";

    const mappedReal = mapPercent(Number(final_decision.real_confidence) || 0);
    const mappedFake = mapPercent(Number(final_decision.fake_confidence) || 0);
    html += `
      <div class="final-decision ${cls}">
        <p>${label}</p>
        <p>Real: ${mappedReal.toFixed(0)}% | Fake: ${mappedFake.toFixed(0)}%</p>
      </div>
    `;

    resultsDiv.innerHTML = html;
  });
});

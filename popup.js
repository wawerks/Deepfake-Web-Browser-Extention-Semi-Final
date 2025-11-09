document.addEventListener("DOMContentLoaded", () => {
  const resultsDiv = document.getElementById("results");

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
      html += `
        <div class="result-item">
          <span class="result-label">${emoji} ${r.model}</span>
          <span>${r.label}</span>
          <span class="result-confidence">(${(r.confidence * 100).toFixed(2)}%)</span>
        </div>
      `;
    });

    // Ensemble summary
    const label = final_decision.final_label;
    let cls = "uncertain";
    if (label.includes("Real")) cls = "real";
    else if (label.includes("Deepfake")) cls = "fake";

    html += `
      <div class="final-decision ${cls}">
        <p>${label}</p>
        <p>Real: ${final_decision.real_confidence}% | Fake: ${final_decision.fake_confidence}%</p>
      </div>
    `;

    resultsDiv.innerHTML = html;
  });
});

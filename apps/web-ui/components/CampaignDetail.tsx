import { CampaignDetail as CampaignDetailType } from "../lib/apiClient";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export function CampaignDetail({ campaign }: { campaign: CampaignDetailType }) {
  return (
    <div>
      <h1>{campaign.title}</h1>
      <p>Status: {campaign.status}</p>

      {campaign.status === "needs_review" && (
        <p role="alert">This campaign needs manual review.</p>
      )}

      {campaign.document && (
        <section>
          <h2>Parsed Document</h2>
          <p>Confidence: {campaign.document.parsing_confidence}</p>
          <ul>
            {campaign.document.extracted_links.map((link) => (
              <li key={link}>
                <a href={link} target="_blank" rel="noreferrer">
                  {link}
                </a>
              </li>
            ))}
          </ul>
          <pre>{campaign.document.raw_text}</pre>
        </section>
      )}

      {campaign.plan && (
        <section>
          <h2>Plan</h2>
          <p>{campaign.plan.strategy_summary}</p>
          <ul>
            {campaign.plan.requirements_checklist.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <pre>{JSON.stringify(campaign.plan.content_plan, null, 2)}</pre>
          <p>Opportunity score: {campaign.plan.opportunity_score}</p>
          <a href={`${API_BASE_URL}/api/campaigns/${campaign.id}/pdf`}>Download PDF</a>
        </section>
      )}
    </div>
  );
}

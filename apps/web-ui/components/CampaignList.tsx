import Link from "next/link";
import { Campaign } from "../lib/apiClient";

export function CampaignList({ campaigns }: { campaigns: Campaign[] }) {
  if (campaigns.length === 0) {
    return <p>No campaigns yet.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <th>Title</th>
          <th>Status</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {campaigns.map((c) => (
          <tr key={c.id}>
            <td>
              <Link href={`/campaigns/${c.id}`}>{c.title}</Link>
            </td>
            <td>{c.status}</td>
            <td>{c.updated_at}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

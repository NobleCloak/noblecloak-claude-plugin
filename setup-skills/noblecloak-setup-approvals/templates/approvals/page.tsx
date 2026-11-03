import { ApprovalsExample } from './ApprovalsExample';
import { ConfigProblem } from './ConfigProblem';
import { readConfig } from './config';

export default function ApprovalsPage() {
  const result = readConfig();
  return (
    <>
      <h1>Approvals</h1>
      {result.ok ? (
        <ApprovalsExample config={result.config} />
      ) : (
        <ConfigProblem problems={result.problems} />
      )}
    </>
  );
}

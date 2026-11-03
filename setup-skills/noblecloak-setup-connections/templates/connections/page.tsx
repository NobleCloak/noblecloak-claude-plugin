import { ConnectionsExample } from './ConnectionsExample';
import { ConfigProblem } from './ConfigProblem';
import { readConfig } from './config';

export default function ConnectionsPage() {
  const result = readConfig();
  return (
    <>
      <h1>Connections</h1>
      {result.ok ? (
        <ConnectionsExample config={result.config} />
      ) : (
        <ConfigProblem problems={result.problems} />
      )}
    </>
  );
}

import { PermissionsExample } from './PermissionsExample';
import { ConfigProblem } from './ConfigProblem';
import { readConfig } from './config';

export default function PermissionsPage() {
  const result = readConfig();
  return (
    <>
      <h1>Permissions</h1>
      {result.ok ? (
        <PermissionsExample config={result.config} />
      ) : (
        <ConfigProblem problems={result.problems} />
      )}
    </>
  );
}

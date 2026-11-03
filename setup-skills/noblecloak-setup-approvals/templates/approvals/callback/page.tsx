import { CallbackClient } from '../CallbackClient';
import { ConfigProblem } from '../ConfigProblem';
import { readConfig } from '../config';

export default function CallbackPage() {
  const result = readConfig();
  return (
    <>
      <h1>Signing in</h1>
      {!result.ok ? (
        <ConfigProblem problems={result.problems} />
      ) : result.config.mode === 'oidc' ? (
        <CallbackClient config={result.config} />
      ) : (
        <p>
          The mock has no sign-in. <a href="/approvals">Back to approvals</a>.
        </p>
      )}
    </>
  );
}

export function ConfigProblem({ problems }: { readonly problems: readonly string[] }) {
  return (
    <section role="alert">
      <h2>This app is not configured</h2>
      <p>
        Copy <code>.env.example</code> to <code>.env.local</code>, fill it in and build again:
      </p>
      <ul>
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </section>
  );
}

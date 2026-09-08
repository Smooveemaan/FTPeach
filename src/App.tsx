import Application from './app/Application.tsx';

/**
 * Root of the application component tree.
 * Renders {@link Application}; platform bootstrapping remains in `main.tsx`.
 */
export default function App() {
  return <Application />;
}

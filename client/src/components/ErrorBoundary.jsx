import { Component } from 'react';
import { RefreshCw, AlertTriangle } from 'lucide-react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  handleReset = () => {
    // React.lazy memoriza rejeições; uma nova carga recupera o chunk após deploy/rede indisponível.
    if (/dynamically imported module|module script failed|loading chunk/i.test(this.state.error?.message || '')) {
      window.location.reload();
      return;
    }
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-neutral-50 via-white to-neutral-50 dark:from-neutral-900 dark:via-neutral-900 dark:to-neutral-800 px-4">
          <div className="text-center max-w-md">
            <div className="w-16 h-16 bg-red-50 dark:bg-red-500/10 rounded-2xl flex items-center justify-center mx-auto mb-5">
              <AlertTriangle size={32} className="text-red-500" />
            </div>
            <h1 className="text-2xl font-bold text-neutral-800 dark:text-neutral-100 mb-2">
              Algo deu errado
            </h1>
            <p className="text-neutral-500 dark:text-neutral-400 mb-6 text-sm">
              Ocorreu um erro inesperado. Tente recarregar a página.
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={this.handleReset}
                className="btn-primary inline-flex items-center gap-2"
              >
                <RefreshCw size={16} />
                Tentar novamente
              </button>
              <button
                onClick={() => window.location.href = '/'}
                className="btn-ghost"
              >
                Ir para início
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import App from './App'
import { AuthProvider } from './contexts/AuthContext'
import { ToastProvider } from './contexts/ToastContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { FeatureFlagsProvider } from './contexts/FeatureFlagsContext'
import { InstitutionalReadModelProvider } from './contexts/InstitutionalReadModelContext'
import { PlannerNavigationProvider } from './contexts/PlannerNavigationContext'
import ErrorBoundary from './components/ErrorBoundary'
import './index.css'

const router = createBrowserRouter([{ path: '*', element:
      <ErrorBoundary>
        <ThemeProvider>
          <AuthProvider>
            <FeatureFlagsProvider>
              <InstitutionalReadModelProvider>
                <ToastProvider>
                  <PlannerNavigationProvider>
                    <App />
                  </PlannerNavigationProvider>
                </ToastProvider>
              </InstitutionalReadModelProvider>
            </FeatureFlagsProvider>
          </AuthProvider>
        </ThemeProvider>
      </ErrorBoundary>
}])

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)

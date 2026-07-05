pipeline {
  agent any

  tools {
    nodejs "node-22"
  }

  stages {
    stage("Install") {
      steps {
        sh "corepack enable"
        sh "corepack prepare pnpm@11.10.0 --activate"
        sh "pnpm install --frozen-lockfile"
      }
    }

    stage("Build") {
      steps {
        sh "pnpm build"
      }
    }

    stage("Contracts") {
      steps {
        sh "node dist/cli.js contracts --schema-only --json > contracts-schema.json"
        sh "node dist/cli.js contracts --command extension --flags-only --json > contracts-extension-flags.json"
        sh "node dist/cli.js contracts --json > contracts-runtime.json"
      }
    }

    stage("Extension Gate") {
      steps {
        sh "node dist/cli.js extension --reload --project --json"
        sh "node dist/cli.js extension --doctor --project --detail summary --strict-exit --json"
      }
    }

    stage("Tests") {
      steps {
        sh "node scripts/run-tests.mjs test -- tests/unit/contracts-command.spec.ts tests/unit/extension-loader.spec.ts tests/unit/extension-command.spec.ts"
        sh "node scripts/run-tests.mjs coverage"
      }
    }
  }
}

#!/usr/bin/env sh
# Loads environment configuration, then execs the given command.
#
#   NODE_ENV=production        -> pulls secrets from GCP Secret Manager (gcloud),
#                                  matching the names in setuprequired/GCP_DEPLOYMENT.md
#   NODE_ENV=<anything else>   -> loads .env.<NODE_ENV> if present, else .env
#
# Usage:
#   ./load-scripts.sh node dist/server.js
#   ./load-scripts.sh npm run worker
#   ./load-scripts.sh npx prisma migrate deploy
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_ENV="${NODE_ENV:-development}"

# VAR_NAME:secret-name, one per line (mirrors setuprequired/GCP_DEPLOYMENT.md §7)
SECRET_VARS="
DATABASE_URL:findemy-database-url
REDIS_URL:findemy-redis-url
JWT_PRIVATE_KEY:findemy-jwt-private-key
JWT_PUBLIC_KEY:findemy-jwt-public-key
MSG91_AUTH_KEY:findemy-msg91-auth-key
MSG91_TEMPLATE_ID:findemy-msg91-template-id
RAZORPAY_KEY_ID:findemy-razorpay-key-id
RAZORPAY_KEY_SECRET:findemy-razorpay-key-secret
RAZORPAY_WEBHOOK_SECRET:findemy-razorpay-webhook-secret
HMS_ACCESS_KEY:findemy-hms-access-key
HMS_SECRET:findemy-hms-secret
HMS_MANAGEMENT_TOKEN:findemy-hms-management-token
HMS_TEMPLATE_ID:findemy-hms-template-id
HMS_WEBHOOK_SECRET:findemy-hms-webhook-secret
R2_ACCOUNT_ID:findemy-r2-account-id
R2_ACCESS_KEY_ID:findemy-r2-access-key-id
R2_SECRET_ACCESS_KEY:findemy-r2-secret-access-key
R2_BUCKET:findemy-r2-bucket
GOOGLE_GEOCODING_KEY:findemy-google-geocoding-key
EXPO_ACCESS_TOKEN:findemy-expo-access-token
SENTRY_DSN:findemy-sentry-dsn
APPLE_STUDENT_BUNDLE_ID:findemy-apple-student-bundle-id
APPLE_ADMIN_BUNDLE_ID:findemy-apple-admin-bundle-id
GOOGLE_STUDENT_IOS_CLIENT_ID:findemy-google-student-ios-client-id
GOOGLE_STUDENT_ANDROID_CLIENT_ID:findemy-google-student-android-client-id
GOOGLE_ADMIN_IOS_CLIENT_ID:findemy-google-admin-ios-client-id
GOOGLE_ADMIN_ANDROID_CLIENT_ID:findemy-google-admin-android-client-id
"

# Required per src/lib/env.ts (Zod schema) - missing these is a hard failure.
REQUIRED_SECRET_VARS="DATABASE_URL REDIS_URL JWT_PRIVATE_KEY JWT_PUBLIC_KEY"

load_from_gcp() {
  command -v gcloud >/dev/null 2>&1 || {
    echo "load-scripts.sh: NODE_ENV=production but gcloud CLI was not found" >&2
    exit 1
  }

  PROJECT_FLAG=""
  if [ -n "${GCP_PROJECT_ID:-}" ]; then
    PROJECT_FLAG="--project=${GCP_PROJECT_ID}"
  fi

  echo "load-scripts.sh: loading secrets from GCP Secret Manager..." >&2

  # Redirect from a heredoc (not a pipe) so `export` below affects this shell,
  # not a subshell.
  while IFS=: read -r VAR_NAME SECRET_NAME; do
    [ -z "$VAR_NAME" ] && continue

    # Already injected into the environment (e.g. Cloud Run --set-secrets)? Keep it.
    eval "CURRENT_VALUE=\${$VAR_NAME:-}"
    if [ -n "$CURRENT_VALUE" ]; then
      continue
    fi

    VALUE=$(gcloud secrets versions access latest --secret="$SECRET_NAME" $PROJECT_FLAG 2>/dev/null) || VALUE=""

    if [ -z "$VALUE" ]; then
      case " $REQUIRED_SECRET_VARS " in
        *" $VAR_NAME "*)
          echo "load-scripts.sh: required secret '$SECRET_NAME' (for \$$VAR_NAME) could not be loaded" >&2
          exit 1
          ;;
      esac
      continue
    fi

    export "$VAR_NAME=$VALUE"
  done <<EOF
$SECRET_VARS
EOF
}

load_from_dotenv() {
  ENV_FILE="$SCRIPT_DIR/.env.${NODE_ENV}"
  [ -f "$ENV_FILE" ] || ENV_FILE="$SCRIPT_DIR/.env"

  if [ -f "$ENV_FILE" ]; then
    echo "load-scripts.sh: loading env from $(basename "$ENV_FILE")" >&2
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
  else
    echo "load-scripts.sh: no .env file found ($ENV_FILE); relying on existing environment" >&2
  fi
}

if [ "$NODE_ENV" = "production" ]; then
  load_from_gcp
else
  load_from_dotenv
fi

if [ "$#" -eq 0 ]; then
  exit 0
fi

exec "$@"

# Deploy the Plato backend for web and Expo

The Flask application serves the desktop site and the pages shown by the Expo mobile app. They share the same backend URL, account sessions, MFA, roles, and database. The container includes `/healthz`, which returns `200` only when the app can reach its configured database.

## AWS deployment path

This project has an `apprunner.yaml` from an earlier setup. AWS App Runner stopped accepting new customers on April 30, 2026. For a new AWS deployment, use Amazon ECS Express Mode, which accepts a container image and provisions a public HTTPS endpoint.

### 1. Prepare AWS

Create your AWS account, enable MFA on the root user, create a least-privilege IAM identity for daily work, and set an AWS Budget alert before provisioning resources. ECS/Fargate, the load balancer, database, logs, storage, and data transfer can incur charges.

Install Docker Desktop and AWS CLI, sign in to AWS, and choose a region. Create an Amazon ECR repository named `plato-lms` and an RDS PostgreSQL database in a private subnet. Configure the database security group to allow PostgreSQL traffic only from the ECS task security group. Do not expose the database publicly.

### 2. Build and push the backend container

Run these commands in PowerShell from the project root. Replace the region with the region where you created ECR:

```powershell
$awsRegion = 'us-east-1'
$awsAccountId = aws sts get-caller-identity --query Account --output text
$ecrHost = "$awsAccountId.dkr.ecr.$awsRegion.amazonaws.com"
$image = "$ecrHost/plato-lms:latest"

aws ecr create-repository --repository-name plato-lms --region $awsRegion
aws ecr get-login-password --region $awsRegion | docker login --username AWS --password-stdin $ecrHost
docker build -t plato-lms:latest .
docker tag plato-lms:latest $image
docker push $image
```

If ECR already has the repository, skip `create-repository`.

### 3. Store configuration and deploy

In AWS Secrets Manager, create secrets for `SECRET_KEY`, `PASSWORD_PEPPER`, `TOTP_ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_KEY`, `DATABASE_URL`, and `INSTRUCTOR_INVITE_CODE`. Generate distinct random keys for each; use a PostgreSQL SQLAlchemy URL such as `postgresql+psycopg://...` with TLS enabled. Never put secrets in the Docker image or GitHub.

In the AWS Console, open **Amazon ECS → Express mode → Create** and select the ECR image. Configure container port `8080`, health check path `/healthz`, production environment variables `APP_ENV=production`, `COOKIE_SECURE=1`, and `PORT=8080`, plus the Secrets Manager values. Choose the task execution and infrastructure roles. Set the task networking so it can reach the private RDS database; restrict inbound PostgreSQL access to the task security group. Review the price estimate and configuration before creating the service.

Wait for the service to become active and verify its HTTPS URL by opening `/healthz`; it should respond with `{"status":"ok"}`.

### 4. Connect the Expo app

In `mobile/.env`, set:

```dotenv
EXPO_PUBLIC_PLATO_URL=https://YOUR-ECS-SERVICE-URL
```

Restart Expo after changing the environment file. On a phone, this must be the deployed HTTPS URL (not `localhost`). The Expo app loads the Flask pages; accounts and course data stay in PostgreSQL on the backend. Do not put server secrets in `EXPO_PUBLIC_*` variables.

### 5. Create the first administrator

Register your account through the deployed site. Use a one-off database query from the authorized AWS database console to promote that account to `admin`:

```sql
UPDATE "user"
SET role = 'admin'
WHERE email = 'your-account-email' AND is_deleted = false;
```

Sign in and complete the required TOTP setup. Then turn off open registration from the Admin dashboard. Do not run sample-user seeding against the production database.

## Local container check

For local Docker runs, provide all required values through a private environment file and use a local database. Never copy `.env` into a container image. The same image can then be used for production with secrets supplied by the hosting platform.

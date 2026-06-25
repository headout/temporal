---
name: mirrord-test
description: "Runs a service locally with mirrord connected to a Kubernetes ODE environment, handling config, app startup, and end-to-end API testing. Use when the user wants to run or test a service with mirrord, says \"run with mirrord\", \"mirrord test\", or \"mirrord exec\"."
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion]
---

# Mirrord Test

Run local service via mirrord connected to Kubernetes ODE, test API changes, report results end-to-end.

## When to Use
- "run with mirrord" / "test my changes with mirrord" / "mirrord test"
- Developer wants to test local code against live Kubernetes environment

---

## Instructions

### Step 1: Pre-flight

**1a. Check mirrord CLI**
```bash
mirrord --version
```
If not installed:
- macOS: `brew install metalbear-co/mirrord/mirrord`
- Linux: `curl -fsSL https://raw.githubusercontent.com/metalbear-co/mirrord/main/scripts/install.sh | bash`

**1b. Check kubectl context**
```bash
kubectl config current-context
```

If context doesn't contain `headout-env-test-ondemand`, switch:
```bash
kubectl config use-context arn:aws:eks:ap-south-1:174451389444:cluster/headout-env-test-ondemand
```

Verify reachability:
```bash
kubectl cluster-info
```
If unreachable, stop and ask developer to check kubeconfig/VPN.

---

### Step 2: Select Service & Mode

Scan existing configs:
```bash
find . -path "./.mirrord/*.json" -name "*.json" | sort
```
Parse unique service names from filenames (e.g. `.mirrord-aries-localhost.json` -> `aries`).

Use `AskUserQuestion` with two questions (service + mode):

```
questions: [
  {
    header: "Service",
    question: "Which service do you want to run?",
    multiSelect: false,
    options: [
      // one entry per unique service name parsed from .mirrord/ filenames
      { label: "<service-name>", description: "Run the <service-name> service" },
      ...
    ]
  },
  {
    header: "Mode",
    question: "Which mirrord mode?",
    multiSelect: false,
    options: [
      { label: "localhost", description: "No incoming traffic — safe for concurrent use, just env/DB/fs mirroring" },
      { label: "mirror", description: "A copy of live traffic is mirrored to your local app (filtered by header)" },
      { label: "steal", description: "Only requests with your header are stolen from the pod" },
      { label: "complete-steal", description: "All traffic stolen — blocks other users, use with caution" }
    ]
  }
]
```

Then ask as plain follow-up: "What's your ODE name?"

If `mirror` or `steal` chosen, make second `AskUserQuestion`:
```
questions: [
  {
    header: "Header",
    question: "What value should be used for the x-mirrord header filter?",
    multiSelect: false,
    options: [
      { label: "dev", description: "x-mirrord: dev" },
      { label: "test", description: "x-mirrord: test" },
      { label: "local", description: "x-mirrord: local" }
    ]
    // User can type a custom value via "Other"
  }
]
```

---

### Step 3: Find or Create Config

**3a. Find existing config** matching chosen service + mode:
```bash
find . -path "./.mirrord/*.json" -name "*.json" | sort
```
If exact match exists, use it (substituting `<ODE_NAME>` via temp copy -- never modify original).

**3b. If no match, create config**

Detect service type:
- Java/Spring Boot: `build.gradle`, `build.gradle.kts`, `pom.xml`
- Python: `manage.py`, `requirements.txt`, `pyproject.toml`
- Node.js: `package.json`

Base template (Java/Spring Boot):
```json
{
  "operator": false,
  "skip_processes": "jspawnhelper;JavaProbe",
  "target": {
    "path": {
      "deployment": "<SERVICE_NAME>"
    },
    "namespace": "<ODE_NAMESPACE>"
  },
  "internal_proxy": {
    "idle_timeout": 300
  },
  "feature": {
    "network": {
      "incoming": {
        "mode": "<MODE>"
      },
      "outgoing": {
        "tcp": true,
        "udp": true,
        "ignore_localhost": true
      },
      "dns": {
        "enabled": true
      }
    },
    "fs": "read",
    "env": true
  }
}
```

For `mirror`/`steal` (filtered), add `http_filter`:
```json
"incoming": {
  "mode": "mirror",
  "http_filter": {
    "header_filter": "x-mirrord: <CUSTOM_HEADER>",
    "ports": [80, 443, 8080]
  }
}
```

For `complete-steal` (steal without header filter):
```json
"incoming": {
  "mode": "steal",
  "http_filter": {
    "ports": [80, 443, 8080]
  }
}
```

For `localhost`:
```json
"incoming": "off"
```

Save to `.mirrord/.mirrord-<service>-<mode>.json`.

**3c. Create temp config with actual namespace:**
```bash
cat .mirrord/.mirrord-<service>-<mode>.json | sed 's/<ODE_NAME>/<actual-namespace>/g' > /tmp/mirrord-active-config.json
```

---

### Step 4: Detect Start Command

Search in order:

**Gradle (Java/Kotlin):**
```bash
# Find module name from settings.gradle or settings.gradle.kts
grep -r "bootRun" build.gradle* --include="*.kts" --include="*.gradle" -l | head -1
ls */build.gradle* 2>/dev/null | head -5
```
Command: `./gradlew :<module-name>:bootRun`

**Maven:**
```bash
find . -name "pom.xml" -maxdepth 2
```
Command: `./mvnw spring-boot:run`

**Python:**
```bash
find . -name "manage.py" -maxdepth 3
find . -name "main.py" -maxdepth 3
```
Command: `python manage.py runserver 0.0.0.0:8080` or `uvicorn main:app --host 0.0.0.0 --port 8080`

**Node.js:**
```bash
cat package.json | grep '"start"'
```
Command: `npm start`

If multiple modules found, ask developer which one. If none detected, ask for start command.

---

### Step 5: Start App

Run in background:
```bash
nohup mirrord exec --config-file /tmp/mirrord-active-config.json -- <start-command> > /tmp/mirrord-app.log 2>&1 &
echo "PID: $!"
```

**Monitor startup (check every 5s, up to 120s):**

Success signals:
- Java/Spring Boot: `Tomcat started on port` or `Started <AppName> in`
- Python Django: `Starting development server`
- Python FastAPI/uvicorn: `Application startup complete`
- Node.js: `listening on` or `Server started`

```bash
# Check agent pod creation
kubectl get pods -n default -l app=mirrord -o wide

# Tail logs
tail -50 /tmp/mirrord-app.log
```

Report: port, active profile (Java), connected services (Kafka, Redis, DB, etc.)

---

### Step 6: Troubleshooting

Analyze `/tmp/mirrord-app.log` for errors.

**Mirrord-level errors (fix these):**

| Error | Fix |
|-------|-----|
| `Detected dirty iptables` | Another session active. Check `kubectl get pods -n default -l app=mirrord`. Ask developer to stop other session or switch to localhost. |
| `OutOfcpu` / pod pending | Check resources: `kubectl describe pod <agent-pod> -n default`. Retry or suggest different target pod. |
| `failed to resolve target` | Wrong deployment/ODE. Verify with `kubectl get deployments -n <namespace>`. |
| `connection refused` / agent not ready | Wait and retry. If persists, delete agent pod to recreate. |
| `mirrord: command not found` | Re-run install step. |

After fix, retry startup (up to 2 retries).

**App-level errors (report, don't fix):**
- DB connection errors, missing env vars, compilation errors, business logic exceptions

Report: "This looks like an application issue: `<error>`. Please check your code/config."

---

### Step 7: Choose Test Approach

Once running, use `AskUserQuestion`:

```
questions: [
  {
    header: "Testing",
    question: "App is running! (mode: <mode>, ODE: <ode>) — How do you want to test?",
    multiSelect: false,
    options: [
      { label: "Describe your change", description: "Tell me what you changed and I'll find the relevant endpoints" },
      { label: "Auto-detect from diff", description: "I'll scan git diff and infer which endpoints to hit" },
      { label: "Provide endpoints manually", description: "Give me exact paths or curl commands" },
      { label: "Skip testing", description: "Just confirm mirrord is working, go straight to report" }
    ]
  }
]
```

---

### Step 8: Find Endpoints

**Describe change:** Search codebase for relevant controllers/routes
- Java: grep `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`, `@RequestMapping`
- Python: grep `@app.route`, `@router.get`, `path(`, `url(`
- Node: grep `router.get`, `router.post`, `app.get`, `app.post`

**Auto-detect from diff:**
```bash
git diff HEAD --name-only
git diff HEAD -- <changed-files>
```
Find changed controller/route files, extract modified endpoint paths.

**Manual:** Accept paths, curl commands, or Postman-style inputs.

**Skip:** Go to final report.

---

### Step 9: Execute Tests

**Determine base URL:**
```bash
# Check what port the app is running on
grep -o "port(s): [0-9]*" /tmp/mirrord-app.log | tail -1
```
Base: `http://localhost:<port>`

**Build curl:**
- `mirror`/`steal` filtered -> add `-H "x-mirrord: <CUSTOM_HEADER>"`
- `localhost`/`complete-steal` -> no special header

```bash
curl -s -o /tmp/mirrord-response.json -w "\n%{http_code}" \
  -H "x-mirrord: test" \
  http://localhost:8080/api/v1/endpoint
```

**Monitor logs during request:**
```bash
# Watch for errors in app logs
tail -f /tmp/mirrord-app.log &
LOG_PID=$!
# run curl
kill $LOG_PID
```

**Evaluate:** 2xx = Pass, 4xx = check if expected, 5xx = Fail (extract error from logs).

---

### Step 10: Report & Cleanup

```
MIRRORD TEST REPORT
Service:    <service-name>
Mode:       <mode>
ODE:        <ode>
Agent Pod:  <pod-name> (<node>)
Profile:    <spring-profile or N/A>

STARTUP
  App started in <Xs>
  Agent pod created
  Connected to: Kafka, DB, Redis (whatever was detected)

API TESTS
  GET /api/v1/endpoint  -> 200 OK
  GET /api/v1/other     -> 200 OK
  POST /api/v1/create   -> 500 (error: ...)

LOGS (relevant excerpts)
  <any warnings or errors during test>

CLEANUP
  App process stopped
  Mirrord agent pod terminated
```

**Cleanup:**
```bash
# Kill app and mirrord processes
kill <app-pid> <mirrord-pid> 2>/dev/null
pkill -f "mirrord intproxy" 2>/dev/null

# Verify agent pod cleanup (wait up to 30s)
sleep 10
kubectl get pods -n default -l app=mirrord
```

---

## Notes

- Always use **temp copy** of config with namespace substituted -- never modify originals
- Java startup takes 30-90s -- be patient
- VPN connectivity check in Step 1 is critical
- `skip_processes: jspawnhelper;JavaProbe` required for Java/Kotlin apps
- Mirror/steal modes modify iptables -- only one session per pod
- Localhost mode always safe for concurrent use

# น้ำท่วมตอนนี้ (water-now) — everyday commands. Run `make` to list them.
#
# The app is two processes: the alert service (water, news, outages, reports;
# :4191) and the map (Vite; :4173 by default). The map reaches the alert
# service through its /api/bkk proxy, so both must run.
#
# Written for the GNU Make 3.81 that ships with macOS: every recipe that
# shares shell variables is one line joined with backslashes.

PORT ?= 4173
ALERT_PORT ?= 4191
HEALTH := http://127.0.0.1:$(ALERT_PORT)/api/bkk/health
VITE := node_modules/.bin/vite
# Background runs keep their process ids and logs here (git-ignored).
RUN := .run

.DEFAULT_GOAL := help
.PHONY: help install env start alert map up down status logs test build preview

help: ## List the commands
	@echo "น้ำท่วมตอนนี้ — make <command>  (map port: PORT=$(PORT))"
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[1m%-9s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (npm install)
	npm install

env: ## Create alert-service/.env from the example, if it is missing
	@if [ -f alert-service/.env ]; then echo "alert-service/.env already exists; left as it is"; \
	else cp alert-service/.env.example alert-service/.env && echo "Created alert-service/.env — set TELEGRAM_BOT_TOKEN in it for Telegram alerts"; fi

start: ## Run the alert service and the map together; Ctrl+C stops both
	@if curl -fsS -o /dev/null $(HEALTH) 2>/dev/null; then \
		echo "Alert service already running on :$(ALERT_PORT); using it."; \
	else \
		node alert-service/index.js & ALERT=$$!; \
		trap 'kill $$ALERT 2>/dev/null' EXIT INT TERM; \
	fi; \
	echo "Map: http://localhost:$(PORT)"; \
	$(VITE) --port $(PORT) --strictPort

alert: ## Run only the alert service (foreground)
	node alert-service/index.js

map: ## Run only the map (foreground); needs the alert service for water data
	$(VITE) --port $(PORT) --strictPort

up: ## Start both in the background; logs in .run/
	@mkdir -p $(RUN)
	@if curl -fsS -o /dev/null $(HEALTH) 2>/dev/null; then \
		echo "Alert service already running on :$(ALERT_PORT)."; \
	else \
		nohup node alert-service/index.js > $(RUN)/alert.log 2>&1 & echo $$! > $(RUN)/alert.pid; \
		echo "Alert service started (log: $(RUN)/alert.log)."; \
	fi
	@if lsof -nP -iTCP:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
		echo "Something is already listening on :$(PORT); map not started (try PORT=...)."; \
	else \
		nohup $(VITE) --port $(PORT) --strictPort > $(RUN)/map.log 2>&1 & echo $$! > $(RUN)/map.pid; \
		echo "Map starting at http://localhost:$(PORT) (log: $(RUN)/map.log). Stop with: make down"; \
	fi

down: ## Stop what `make up` started
	@for name in map alert; do \
		pid=$$(cat $(RUN)/$$name.pid 2>/dev/null); \
		if [ -n "$$pid" ] && kill $$pid 2>/dev/null; then echo "Stopped $$name ($$pid)."; \
		else echo "No $$name started by make up."; fi; \
		rm -f $(RUN)/$$name.pid; \
	done

status: ## Show whether the alert service and the map are up
	@if curl -fsS -o /dev/null $(HEALTH) 2>/dev/null; then echo "alert service: up   ($(HEALTH))"; \
	else echo "alert service: down"; fi
	@if curl -fsS -o /dev/null http://localhost:$(PORT)/ 2>/dev/null; then echo "map:           up   (http://localhost:$(PORT))"; \
	else echo "map:           down (port $(PORT))"; fi

logs: ## Follow the logs of what `make up` started
	@tail -n 20 -f $(RUN)/alert.log $(RUN)/map.log

test: ## Run all tests and the module boundary check
	npm test
	npm run test:alert
	npm run check:boundaries

build: ## Build the map for production into dist/
	npm run build

preview: ## Serve the built map (run `make build` first; needs the alert service)
	npm run preview -- --port $(PORT) --strictPort

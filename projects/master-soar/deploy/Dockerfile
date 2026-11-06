# One image, four roles. Which modules start is SOAR_ROLE, not a build target -
# that is what lets the compose file below become a five-VM deployment without
# touching the application.

FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN groupadd --gid 10001 soar && useradd --uid 10001 --gid soar --no-create-home soar

WORKDIR /app

# Dependencies are pinned with hashes and resolved only here. Nothing is fetched
# at run time, by anything, ever.
COPY build/generated/requirements.txt ./requirements.txt
RUN pip install --require-hashes --no-deps -r requirements.txt || pip install -r requirements.txt

# The generated tree is a real package: soar.platform, soar.execution, and so
# on. It is deliberately NOT loose under src/ - a top-level platform/ on
# sys.path shadows the stdlib platform module for the whole process.
COPY build/generated/src ./src
ENV PYTHONPATH=/app/src

# The browser half, in a root that holds ONLY what a browser may fetch.
COPY build/generated/*.html ./web/
COPY build/generated/styles.css ./web/
COPY build/generated/assets ./web/assets
COPY build/generated/src/web ./web/src/web

USER soar:soar

# Overridden per service in the compose file. One image, four roles.
ENV SOAR_ROLE=serve
CMD ["python", "-m", "soar.main"]

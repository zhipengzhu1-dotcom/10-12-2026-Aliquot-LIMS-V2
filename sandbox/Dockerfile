# The Sandbox image (ADR-0003). Scripts and inputs are mounted at run time,
# never baked in. Build from the repository root:
#   docker build -f sandbox/Dockerfile -t aliquot-sandbox:dev sandbox
FROM python:3.13-slim@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

COPY image-requirements.txt /tmp/image-requirements.txt
RUN pip install --require-hashes --only-binary=:all: -r /tmp/image-requirements.txt \
    && rm /tmp/image-requirements.txt \
    && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin sandbox

USER 10001:10001
WORKDIR /tmp

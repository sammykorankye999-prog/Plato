FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY plato-lms/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY plato-lms/app.py ./app.py
COPY plato-lms/templates ./templates
COPY plato-lms/static ./static

RUN useradd --create-home --uid 10001 plato \
    && mkdir -p /app/instance \
    && chown -R plato:plato /app
USER plato

EXPOSE 10000
CMD ["sh", "-c", "gunicorn --bind 0.0.0.0:${PORT:-10000} --workers 2 --threads 4 --timeout 120 app:app"]

FROM python:3.12-alpine

WORKDIR /app
COPY tracker.py .

# Output folder (mount a volume here to keep the logs)
ENV OUT_DIR=/data
VOLUME /data

CMD ["python", "tracker.py"]

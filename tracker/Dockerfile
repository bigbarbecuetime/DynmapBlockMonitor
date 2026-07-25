FROM python:3.12-alpine

WORKDIR /app
COPY tracker.py .
# The viewer ships in the same image. docker-compose runs a second service from it
# with a different command, so there is nothing extra to build, pull or install --
# the viewer is stdlib-only static files, same as the tracker.
COPY viewer ./viewer

# Output folder (mount a volume here to keep the logs)
ENV OUT_DIR=/data
VOLUME /data

CMD ["python", "tracker.py"]

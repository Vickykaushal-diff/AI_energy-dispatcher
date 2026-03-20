# Python base image
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements
COPY requirements.txt .

# Install Python packages
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend code
COPY . .

# Expose port 7860 (Hugging Face default)
EXPOSE 7860

# Start server
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "7860"]
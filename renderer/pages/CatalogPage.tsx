/**
 * Catalog Page
 * 
 * Browse and download legal open-source software.
 */

import React, { useState, useEffect } from 'react';
import { CatalogEntry } from '../../shared/types';
import { Button, Icon, Alert, EmptyState, Badge } from '../components';
import './CatalogPage.css';

const CatalogPage: React.FC = () => {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadCatalog();
  }, []);

  // Auto-dismiss messages
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  const loadCatalog = async () => {
    try {
      const entries = await window.api.getCatalog();
      setCatalog(entries);
    } catch (error) {
      console.error('Failed to load catalog:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async (entry: CatalogEntry) => {
    try {
      setMessage(null);
      setDownloading((prev) => new Set(prev).add(entry.id));
      
      await window.api.addDownload({
        sourceType: 'catalog',
        sourceUri: entry.magnetUri,
        name: entry.name,
      });
      
      setMessage({ type: 'success', text: `Added "${entry.name}" to downloads` });
    } catch (error) {
      setMessage({
        type: 'error',
        text: `Failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    } finally {
      setDownloading((prev) => {
        const next = new Set(prev);
        next.delete(entry.id);
        return next;
      });
    }
  };

  // Get unique categories
  const categories = [...new Set(catalog.map((e) => e.category))].sort();

  // Filter entries
  const filteredEntries = catalog.filter((entry) => {
    const matchesSearch = 
      !searchQuery ||
      entry.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      entry.description.toLowerCase().includes(searchQuery.toLowerCase());
    
    const matchesCategory = !selectedCategory || entry.category === selectedCategory;
    
    return matchesSearch && matchesCategory;
  });

  // Group by category
  const groupedEntries = filteredEntries.reduce((acc, entry) => {
    if (!acc[entry.category]) {
      acc[entry.category] = [];
    }
    acc[entry.category].push(entry);
    return acc;
  }, {} as Record<string, CatalogEntry[]>);

  if (loading) {
    return (
      <div className="page-loading">
        <span className="spinner spinner-lg" />
        <p>Loading catalog...</p>
      </div>
    );
  }

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">OSS Catalog</h1>
      </div>

      <div className="page-content">
        {/* Search and filter */}
        <div className="catalog-filters">
          <div className="catalog-search">
            <Icon name="search" size={18} />
            <input
              type="text"
              placeholder="Search software..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="catalog-search-input"
            />
          </div>
          
          <div className="catalog-categories">
            <button
              className={`category-chip ${selectedCategory === null ? 'active' : ''}`}
              onClick={() => setSelectedCategory(null)}
            >
              All
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                className={`category-chip ${selectedCategory === cat ? 'active' : ''}`}
                onClick={() => setSelectedCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Messages */}
        {message && (
          <Alert 
            variant={message.type} 
            onClose={() => setMessage(null)}
            className="message-alert"
          >
            {message.text}
          </Alert>
        )}

        {/* Catalog grid */}
        {filteredEntries.length === 0 ? (
          <EmptyState
            icon="search"
            title="No results found"
            description="Try adjusting your search or filters."
          />
        ) : (
          <div className="catalog-sections">
            {Object.entries(groupedEntries).map(([category, entries]) => (
              <div key={category} className="catalog-section">
                <h2 className="catalog-section-title">{category}</h2>
                <div className="catalog-grid">
                  {entries.map((entry) => (
                    <div key={entry.id} className="catalog-card">
                      <div className="catalog-card-body">
                        <h3 className="catalog-card-title">{entry.name}</h3>
                        <p className="catalog-card-description">{entry.description}</p>
                        <div className="catalog-card-meta">
                          <Badge>{entry.size}</Badge>
                        </div>
                      </div>
                      <div className="catalog-card-footer">
                        <Button
                          variant="primary"
                          icon={<Icon name="download" size={16} />}
                          onClick={() => handleDownload(entry)}
                          loading={downloading.has(entry.id)}
                          disabled={downloading.has(entry.id)}
                        >
                          Download
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Legal notice */}
        <div className="legal-notice">
          <Icon name="info" size={16} />
          <span>
            All software in this catalog is open-source and legally distributable.
            Please respect the licenses of each project.
          </span>
        </div>
      </div>
    </>
  );
};

export default CatalogPage;

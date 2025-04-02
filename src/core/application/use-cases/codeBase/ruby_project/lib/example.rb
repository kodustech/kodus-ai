# Require da stdlib
require 'json'
require 'date'

# Require relativo
require_relative 'example/version'
require_relative 'example/user'

# Autoload de classes
module Example
  autoload :Config, 'example/config'
  autoload :Client, 'example/client'
  
  # Include de módulo
  include Enumerable
  
  class Error < StandardError; end
  
  def self.configure
    yield(Config.instance)
  end
end

# Load de arquivo (recarrega cada vez)
load 'example/constants.rb'
